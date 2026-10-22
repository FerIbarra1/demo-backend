import BetterSqlite3 from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentConfig } from './config';

/**
 * Almacén local durable (SQLite) para checkpoints y cola de uploads.
 *
 * Aunque el servidor de la nube guarda el "checkpoint oficial" en
 * `SyncCheckpoint` (Prisma), el agente mantiene una copia local para:
 *   1. No pedir el checkpoint a la nube en cada arranque (evita dependencia).
 *   2. Sobrevivir caídas de la nube: si la nube está offline, el agente
 *      puede seguir acumulando BANDEJA_SYNC localmente en la cola `outbox`
 *      y subir todo cuando vuelva.
 *
 * Estructura:
 *   - checkpoints(tienda_id INTEGER PRIMARY KEY, ultimo_bandeja_id INTEGER,
 *     pedido_external_id INTEGER, updated_at INTEGER)
 *   - outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, tienda_id INTEGER,
 *     payload TEXT NOT NULL, attempts INTEGER, next_attempt_at INTEGER,
 *     created_at INTEGER)
 *
 * El archivo se guarda en `<dir del binario>/agent-data.db` (creado si
 * no existe). En modo dev se puede sobrescribir con AGENT_DATA_DIR.
 */
export class LocalStore {
  private db: BetterSqlite3.Database;

  constructor(private config: AgentConfig) {
    const dataDir = process.env.AGENT_DATA_DIR ?? path.join(path.dirname(process.execPath), 'agent-data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'agent-data.db');
    this.db = new BetterSqlite3(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        tienda_id INTEGER PRIMARY KEY,
        ultimo_bandeja_id INTEGER NOT NULL DEFAULT 0,
        pedido_external_id INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tienda_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (next_attempt_at);
      CREATE TABLE IF NOT EXISTS pedido_delivery (
        tienda_id INTEGER NOT NULL,
        pedido_id INTEGER NOT NULL,
        external_id_pedidos INTEGER,
        external_folio TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tienda_id, pedido_id)
      );
      -- Oct 2026 (parte B): los folios que el agente YA tomó de CONSECUTIVOS para la nube. Un número tomado no se
      -- devuelve: si el ACK a la nube falla, el siguiente ciclo reusa ESTE en vez de gastar otro. estado: 0 =
      -- por confirmar a la nube, 1 = confirmado, 2 = la nube lo rechazó N veces (se abandona; queda el rastro).
      CREATE TABLE IF NOT EXISTS folio_reservado (
        tienda_id INTEGER NOT NULL,
        pedido_id INTEGER NOT NULL,
        folio TEXT NOT NULL,
        estado INTEGER NOT NULL DEFAULT 0,
        intentos INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tienda_id, pedido_id)
      );
      CREATE TABLE IF NOT EXISTS ack_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tienda_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ack_outbox_due_idx ON ack_outbox (next_attempt_at);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  // ---------------- meta (flags de bootstrap) ----------------

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ---------------- checkpoints ----------------

  getCheckpoint(tiendaId: number): { ultimoBANDEJAId: number; pedidoExternalId: number | null } | null {
    const row = this.db
      .prepare(`SELECT ultimo_bandeja_id, pedido_external_id FROM checkpoints WHERE tienda_id = ?`)
      .get(tiendaId) as { ultimo_bandeja_id: number; pedido_external_id: number | null } | undefined;
    if (!row) return null;
    return { ultimoBANDEJAId: row.ultimo_bandeja_id, pedidoExternalId: row.pedido_external_id };
  }

  /**
   * C1 (ago 2026): devuelve el MÍNIMO `ultimo_bandeja_id` entre todas las
   * tiendas con checkpoint. Usado por UpProcessor para decidir desde qué
   * BANDEJA_ID leer sin perder eventos de tiendas rezagadas.
   *
   * Devuelve 0 si ninguna tienda tiene checkpoint (arranque en frío).
   */
  minCheckpointPorTienda(): number {
    const row = this.db
      .prepare(
        `SELECT MIN(ultimo_bandeja_id) AS min_id FROM checkpoints WHERE ultimo_bandeja_id > 0`,
      )
      .get() as { min_id: number | null } | undefined;
    return row?.min_id ?? 0;
  }

  setCheckpoint(tiendaId: number, ultimoBANDEJAId: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (tienda_id, ultimo_bandeja_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (tienda_id) DO UPDATE SET
           ultimo_bandeja_id = MAX(checkpoints.ultimo_bandeja_id, excluded.ultimo_bandeja_id),
           updated_at = excluded.updated_at`,
      )
      .run(tiendaId, ultimoBANDEJAId, Date.now());
  }

  setPedidoDelivery(
    tiendaId: number,
    pedidoIdNube: number,
    externalIdPEDIDOS: number,
    externalFolio: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pedido_delivery
           (tienda_id, pedido_id, external_id_pedidos, external_folio, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tienda_id, pedido_id) DO UPDATE SET
           external_id_pedidos = excluded.external_id_pedidos,
           external_folio = excluded.external_folio,
           updated_at = excluded.updated_at`,
      )
      .run(tiendaId, pedidoIdNube, externalIdPEDIDOS, externalFolio, Date.now());
  }

  getPedidoDelivery(
    tiendaId: number,
    pedidoIdNube: number,
  ): { externalIdPEDIDOS: number | null; externalFolio: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT external_id_pedidos, external_folio
         FROM pedido_delivery
         WHERE tienda_id = ? AND pedido_id = ?`,
      )
      .get(tiendaId, pedidoIdNube) as
      | { external_id_pedidos: number | null; external_folio: string | null }
      | undefined;
    if (!row) return null;
    return {
      externalIdPEDIDOS: row.external_id_pedidos,
      externalFolio: row.external_folio,
    };
  }

  // ---------------- folios reservados (parte B) ----------------

  getFolioReservado(tiendaId: number, pedidoId: number): string | null {
    const row = this.db
      .prepare(`SELECT folio FROM folio_reservado WHERE tienda_id = ? AND pedido_id = ?`)
      .get(tiendaId, pedidoId) as { folio: string } | undefined;
    return row?.folio ?? null;
  }

  /** Guarda el folio recién tomado de Firebird, ANTES de avisar a la nube. No pisa uno ya reservado. */
  setFolioReservado(tiendaId: number, pedidoId: number, folio: string): void {
    this.db
      .prepare(
        `INSERT INTO folio_reservado (tienda_id, pedido_id, folio, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tienda_id, pedido_id) DO NOTHING`,
      )
      .run(tiendaId, pedidoId, folio, Date.now());
  }

  /** Los reservados que la nube todavía no confirmó (su ACK se perdió o fue rechazado). */
  foliosSinConfirmar(): Array<{ tiendaId: number; pedidoId: number; folio: string; intentos: number }> {
    const rows = this.db
      .prepare(
        `SELECT tienda_id, pedido_id, folio, intentos FROM folio_reservado WHERE estado = 0 ORDER BY created_at ASC`,
      )
      .all() as Array<{ tienda_id: number; pedido_id: number; folio: string; intentos: number }>;
    return rows.map((r) => ({
      tiendaId: r.tienda_id,
      pedidoId: r.pedido_id,
      folio: r.folio,
      intentos: r.intentos,
    }));
  }

  confirmarFolio(tiendaId: number, pedidoId: number): void {
    this.db
      .prepare(`UPDATE folio_reservado SET estado = 1 WHERE tienda_id = ? AND pedido_id = ?`)
      .run(tiendaId, pedidoId);
  }

  /** La nube lo rechazó: cuenta el intento y, pasado el tope, lo abandona para no insistir para siempre. */
  rechazarFolio(tiendaId: number, pedidoId: number, maxIntentos: number): void {
    this.db
      .prepare(
        `UPDATE folio_reservado
            SET intentos = intentos + 1,
                estado = CASE WHEN intentos + 1 >= ? THEN 2 ELSE estado END
          WHERE tienda_id = ? AND pedido_id = ?`,
      )
      .run(maxIntentos, tiendaId, pedidoId);
  }

  // ---------------- ack outbox (cola durable de confirmaciones) ----------------

  enqueueAck(tiendaId: number, payload: object): number {
    const info = this.db
      .prepare(
        `INSERT INTO ack_outbox (tienda_id, payload, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tiendaId, JSON.stringify(payload), Date.now(), Date.now());
    return Number(info.lastInsertRowid);
  }

  dueAcks(limit: number): Array<{ id: number; tiendaId: number; payload: any; attempts: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, tienda_id, payload, attempts
         FROM ack_outbox
         WHERE next_attempt_at <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(Date.now(), limit) as Array<{
      id: number;
      tienda_id: number;
      payload: string;
      attempts: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      tiendaId: row.tienda_id,
      payload: JSON.parse(row.payload),
      attempts: row.attempts,
    }));
  }

  deleteAcks(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM ack_outbox WHERE id IN (${placeholders})`).run(...ids);
  }

  scheduleAckRetry(ids: number[], backoffSeconds: number, lastError: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE ack_outbox
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?
         WHERE id IN (${placeholders})`,
      )
      .run(Date.now() + backoffSeconds * 1000, lastError, ...ids);
  }

  // ---------------- outbox (cola durable de uploads) ----------------

  enqueue(tiendaId: number, payload: object): number {
    const info = this.db
      .prepare(`INSERT INTO outbox (tienda_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(tiendaId, JSON.stringify(payload), Date.now(), Date.now());
    return Number(info.lastInsertRowid);
  }

  /**
   * Devuelve batches listos para subir (next_attempt_at <= now), ordenados
   * por id. NO los borra: se borran tras recibir 2xx del servidor.
   */
  dueOutbox(limit: number): Array<{ id: number; tiendaId: number; payload: any; attempts: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, tienda_id, payload, attempts FROM outbox
         WHERE next_attempt_at <= ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(Date.now(), limit) as Array<{ id: number; tienda_id: number; payload: string; attempts: number }>;
    return rows.map((r) => ({
      id: r.id,
      tiendaId: r.tienda_id,
      payload: JSON.parse(r.payload),
      attempts: r.attempts,
    }));
  }

  deleteOutbox(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM outbox WHERE id IN (${placeholders})`).run(...ids);
  }

  /**
   * Marca como reintento con backoff. lastError se guarda para diagnóstico.
   * next_attempt_at = now + backoffSeconds.
   */
  scheduleOutboxRetry(ids: number[], backoffSeconds: number, lastError: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const nextAt = Date.now() + backoffSeconds * 1000;
    this.db
      .prepare(
        `UPDATE outbox
         SET attempts = attempts + 1,
             next_attempt_at = ?,
             last_error = ?
         WHERE id IN (${placeholders})`,
      )
      .run(nextAt, lastError, ...ids);
  }

  /**
   * Housekeeping: borra outbox con más de N días. Se llama una vez al día.
   */
  purgeOldOutbox(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const info = this.db.prepare(`DELETE FROM outbox WHERE created_at < ?`).run(cutoff);
    return info.changes;
  }
}
