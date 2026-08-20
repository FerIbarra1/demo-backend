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
    `);
  }

  close() {
    this.db.close();
  }

  // ---------------- checkpoints ----------------

  getCheckpoint(tiendaId: number): { ultimoBANDEJAId: number; pedidoExternalId: number | null } | null {
    const row = this.db
      .prepare(`SELECT ultimo_bandeja_id, pedido_external_id FROM checkpoints WHERE tienda_id = ?`)
      .get(tiendaId) as { ultimo_bandeja_id: number; pedido_external_id: number | null } | undefined;
    if (!row) return null;
    return { ultimoBANDEJAId: row.ultimo_bandeja_id, pedidoExternalId: row.pedido_external_id };
  }

  setCheckpoint(tiendaId: number, ultimoBANDEJAId: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (tienda_id, ultimo_bandeja_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (tienda_id) DO UPDATE SET ultimo_bandeja_id = excluded.ultimo_bandeja_id, updated_at = excluded.updated_at`,
      )
      .run(tiendaId, ultimoBANDEJAId, Date.now());
  }

  setPedidoExternalId(tiendaId: number, pedidoIdNube: number, externalIdPEDIDOS: number): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (tienda_id, ultimo_bandeja_id, pedido_external_id, updated_at)
         VALUES (?, COALESCE((SELECT ultimo_bandeja_id FROM checkpoints WHERE tienda_id = ?), 0), ?, ?)
         ON CONFLICT (tienda_id) DO UPDATE SET pedido_external_id = excluded.pedido_external_id, updated_at = excluded.updated_at`,
      )
      .run(tiendaId, tiendaId, externalIdPEDIDOS, Date.now());
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
