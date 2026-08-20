import type { FirebirdClient } from './firebird-client';
import type { CloudClient, UploadEvent, UploadResponse } from './cloud-client';
import type { LocalStore } from './checkpoint-store';
import type { TiendaResolver } from './tienda-resolver';
import type { Logger } from './logger-types';
import type { AgentConfig } from './config';
import { AuthError, TransientError } from './cloud-client';

/**
 * UP-processor: sincroniza Firebird -> Nube.
 *
 * Ciclo:
 *   1. Lee BANDEJA_SYNC.ID > :lastCheckpoint (top N por tienda).
 *   2. Para cada ID, lee el registro completo de su tabla y arma un
 *      UploadEvent con `datos` ya poblado.
 *   3. Resuelve el IDTIENDA vía TiendaResolver.
 *   4. Si la nube está online: POST /upload con el batch.
 *      - Si 2xx → borra los IDs procesados del outbox y avanza checkpoint.
 *      - Si TransientError → reencola con backoff.
 *      - Si AuthError → log fatal y aborta.
 *   5. Si la nube está offline: encola en outbox local (SQLite) y sube
 *      en orden cuando vuelva.
 *
 * Importante: si la entidad se ignora por no tener handler (ej. MOVCLI
 * no se sincroniza en esta fase), se cuenta como procesada para no
 * quedarse atascada en el mismo BANDEJA_SYNC.ID para siempre.
 */

const ENTIDADES_CON_HANDLER = new Set([
  'PRODUCTOS',
  'CORRIDAS',
  'CORRIDASREN',
  'COLORES',
  'LINEAS',
  'SUBLINEAS',
  'PRECIOS',
  'PRECIOSCO',
  'CLIENTES',
  'CLIENTESCXC',
  'CLITIEN',
  'CLITIENCXC',
  'VENDEDORES',
  'PEDIDOS',
  'MOVPED',
]);

export class UpProcessor {
  constructor(
    private cfg: AgentConfig,
    private fb: FirebirdClient,
    private cloud: CloudClient,
    private store: LocalStore,
    private tiendaResolver: TiendaResolver,
    private log: Logger,
  ) {}

  /**
   * Un ciclo completo de subida. Devuelve el número de IDs procesados.
   */
  async runOnce(): Promise<{ procesados: number }> {
    // 1. Procesar outbox pendiente (lo que se quedó sin subir por
    //    estar la nube caída).
    const pending = this.store.dueOutbox(this.cfg.sync.batchSize);
    if (pending.length > 0) {
      await this.flushOutbox(pending);
    }

    // 2. Sondear BANDEJA_SYNC para cada tienda y armar batches.
    let totalProcesados = 0;
    for (const tiendaIdNube of this.cfg.cloud.sucursalIds) {
      const cp = this.store.getCheckpoint(tiendaIdNube);
      const desdeId = cp?.ultimoBANDEJAId ?? 0;

      const eventos = await this.colectar(tiendaIdNube, desdeId);
      if (eventos.length === 0) continue;

      const hastaId = eventos[eventos.length - 1]._bandejaId;
      const upload: UploadEvent[] = eventos
        .filter((e) => e.entidad && ENTIDADES_CON_HANDLER.has(e.entidad))
        .map(({ _bandejaId, ...rest }) => rest);

      if (upload.length === 0) {
        // Solo marcar el avance del checkpoint para no re-leer siempre los
        // mismos IDs.
        this.store.setCheckpoint(tiendaIdNube, hastaId);
        this.log.info({ tiendaIdNube, hastaId, skipped: eventos.length }, 'up: solo entidades sin handler');
        totalProcesados += eventos.length;
        continue;
      }

      try {
        const res = await this.cloud.upload({
          tiendaId: tiendaIdNube,
          hastaBANDEJAId: hastaId,
          eventos: upload,
        });
        if (res.checkpointAvanzado) {
          this.store.setCheckpoint(tiendaIdNube, hastaId);
          this.log.info(
            { tiendaIdNube, hastaId, ok: res.procesados, err: res.errores },
            'up: batch subido OK',
          );
        } else {
          // Servidor avanzó parcialmente. NO avanzar el checkpoint local:
          // los eventos fallidos se reintentarán en el próximo ciclo.
          this.log.warn(
            { tiendaIdNube, ok: res.procesados, err: res.errores },
            'up: batch con errores, checkpoint no avanza',
          );
        }
        totalProcesados += res.procesados;
      } catch (err) {
        if (err instanceof AuthError) {
          this.log.fatal({ err: err.message }, 'up: auth rejected — abortando');
          throw err;
        }
        if (err instanceof TransientError) {
          // Encolar a outbox para reintento con backoff.
          this.log.warn({ tiendaIdNube, err: err.message }, 'up: transient error, encolando');
          for (const ev of upload) {
            this.store.enqueue(tiendaIdNube, ev);
          }
          // Backoff al ciclo completo.
          await this.sleep(this.cfg.sync.backoffMinMs);
          continue;
        }
        this.log.error({ tiendaIdNube, err: (err as Error).message }, 'up: error inesperado');
      }
    }

    return { procesados: totalProcesados };
  }

  /**
   * Lee BANDEJA_SYNC.ID > :lastCheckpoint, top N. Para cada ID, lee el
   * registro completo de su tabla y resuelve IDTIENDA.
   */
  private async colectar(tiendaIdNube: number, desdeId: number): Promise<Array<UploadEvent & { _bandejaId: number }>> {
    // Nota: BANDEJA_SYNC no tiene IDTIENDA, así que la query es global
    // (una sola BD central). El IDTIENDA se deduce por entidad en el
    // resolver.
    const bandejas = await this.fb.query<{
      ID: number;
      TABLA: string;
      IDTABLA: number;
      OPERACION: string;
    }>(
      `SELECT FIRST ${this.cfg.sync.batchSize} ID, TRIM(TABLA) AS TABLA, IDTABLA, OPERACION
       FROM BANDEJA_SYNC
       WHERE ID > ?
       ORDER BY ID ASC`,
      [desdeId],
    );

    if (bandejas.length === 0) return [];

    const eventos: Array<UploadEvent & { _bandejaId: number }> = [];
    for (const b of bandejas) {
      const tipo = this.tipoParaEntidad(b.TABLA);
      const eventoBase: any = {
        tipo,
        operacion: b.OPERACION as 'I' | 'U' | 'D',
        entidad: b.TABLA,
        localId: b.IDTABLA,
        datos: await this.leerRegistro(b.TABLA, b.IDTABLA),
      };

      // Resolver IDTIENDA. Para entidades globales (PRODUCTOS, etc.)
      // devuelve null — se procesan una sola vez, sin tienda.
      // Para CLIENTES/CLIENTESCXC, SI el cliente está dado de alta en
      // VARIAS tiendas en CLITIEN, emitimos un evento por tienda.
      const idTiendas = await this.tiendasPara(b.TABLA, b.IDTABLA);
      if (idTiendas.length === 0 && !this.esGlobal(b.TABLA)) {
        // Cliente sin CLITIEN — descartar el evento.
        this.log.warn({ tabla: b.TABLA, localId: b.IDTABLA }, 'up: entidad sin tienda, descartada');
        eventos.push({ ...eventoBase, _bandejaId: b.ID });
        continue;
      }
      for (const idTienda of idTiendas.length === 0 ? [null] : idTiendas) {
        eventos.push({
          ...eventoBase,
          localTiendaId: idTienda ?? undefined,
          _bandejaId: b.ID,
        });
      }
    }

    return eventos;
  }

  /**
   * Lee el registro completo de la tabla según la entidad del BANDEJA_SYNC.
   */
  private async leerRegistro(tabla: string, idTabla: number): Promise<Record<string, unknown>> {
    // Lista blanca de tablas por seguridad.
    const allowed = new Set([
      'PRODUCTOS', 'PRECIOS', 'PRECIOSCO',
      'CORRIDAS', 'CORRIDASREN', 'COLORES', 'LINEAS', 'SUBLINEAS',
      'CLIENTES', 'CLIENTESCXC', 'CLITIEN', 'CLITIENCXC',
      'VENDEDORES', 'PEDIDOS', 'MOVPED',
    ]);
    if (!allowed.has(tabla)) return {};

    // Importante: SQL dinámico es peligroso si la tabla viene del usuario.
    // Aquí la `tabla` viene de un TRIGGER Firebird que el DBA escribió,
    // así que es controlada. Pero validamos con whitelist.
    const cols = await this.columnas(tabla);
    const sql = `SELECT ${cols} FROM ${tabla} WHERE ${this.pkDe(tabla)} = ?`;
    const rows = await this.fb.query<Record<string, unknown>>(sql, [idTabla]);
    return rows[0] ?? {};
  }

  /**
   * Cachea la lista de columnas por tabla para evitar repetir
   * `SELECT ... FROM RDB$RELATION_FIELDS` cada vez.
   */
  private columnasCache = new Map<string, string>();
  private async columnas(tabla: string): Promise<string> {
    if (this.columnasCache.has(tabla)) return this.columnasCache.get(tabla)!;
    const rows = await this.fb.query<{ COL: string }>(
      `SELECT TRIM(RDB$FIELD_NAME) AS COL FROM RDB$RELATION_FIELDS
       WHERE RDB$RELATION_NAME = ?
       ORDER BY RDB$FIELD_POSITION`,
      [tabla],
    );
    const list = rows.map((r) => `"${r.COL}"`).join(', ');
    this.columnasCache.set(tabla, list);
    return list;
  }

  private pkDe(tabla: string): string {
    const map: Record<string, string> = {
      PRODUCTOS: 'IDPRODUCTO',
      PRECIOS: 'IDPRECIO',
      PRECIOSCO: 'IDPRECIOCO',
      CORRIDAS: 'IDCORRIDA',
      CORRIDASREN: 'IDCORRIDAREN',
      COLORES: 'IDCOLOR',
      LINEAS: 'IDLINEA',
      SUBLINEAS: 'IDSUBLINEA',
      CLIENTES: 'IDCLIENTE',
      CLIENTESCXC: 'IDCLIENTE',
      CLITIEN: 'IDCLIENTETIEN',
      CLITIENCXC: 'IDCLIENTETIEN',
      VENDEDORES: 'IDVENDEDOR',
      PEDIDOS: 'IDPEDIDO',
      MOVPED: 'IDMOVPED',
    };
    return map[tabla] ?? 'ID';
  }

  /**
   * Devuelve el conjunto de tiendas para un evento. Una sola tienda para
   * la mayoría; para CLIENTES/CLIENTESCXC puede ser N (multi-sucursal).
   * Para entidades globales devuelve [] — se procesan una vez sin tienda.
   */
  private async tiendasPara(tabla: string, localId: number): Promise<number[]> {
    if (this.esGlobal(tabla)) return [];
    if (tabla === 'CLIENTES') {
      const rows = await this.fb.query<{ IDTIENDA: number }>(
        'SELECT IDTIENDA FROM CLITIEN WHERE IDCLIENTE = ?',
        [localId],
      );
      return rows.map((r) => r.IDTIENDA);
    }
    if (tabla === 'CLIENTESCXC') {
      const rows = await this.fb.query<{ IDTIENDA: number }>(
        'SELECT IDTIENDA FROM CLITIENCXC WHERE IDCLIENTE = ?',
        [localId],
      );
      return rows.map((r) => r.IDTIENDA);
    }
    // Para el resto, el IDTIENDA viene en el registro mismo.
    return []; // el resolver lo rellena
  }

  private esGlobal(tabla: string): boolean {
    return ['PRODUCTOS', 'CORRIDAS', 'CORRIDASREN', 'COLORES', 'LINEAS', 'SUBLINEAS'].includes(tabla);
  }

  private tipoParaEntidad(entidad: string): 'CATALOGO' | 'CLIENTE' | 'PEDIDO' | 'PAGO' {
    if (entidad.startsWith('CLIENT')) return 'CLIENTE';
    if (entidad === 'PEDIDOS' || entidad === 'MOVPED') return 'PAGO';
    return 'CATALOGO';
  }

  /**
   * Procesa el outbox acumulado. Lo intenta en un solo POST batch.
   */
  private async flushOutbox(pending: Array<{ id: number; tiendaId: number; payload: UploadEvent; attempts: number }>) {
    // Agrupar por tienda para hacer un POST por tienda (limitación del
    // endpoint actual).
    const porTienda = new Map<number, Array<{ id: number; payload: UploadEvent }>>();
    for (const p of pending) {
      if (!porTienda.has(p.tiendaId)) porTienda.set(p.tiendaId, []);
      porTienda.get(p.tiendaId)!.push({ id: p.id, payload: p.payload });
    }

    for (const [tiendaIdNube, items] of porTienda.entries()) {
      try {
        const res = await this.cloud.upload({
          tiendaId: tiendaIdNube,
          hastaBANDEJAId: 0, // el outbox no avanza checkpoint
          eventos: items.map((i) => i.payload),
        });
        if (res.errores === 0) {
          this.store.deleteOutbox(items.map((i) => i.id));
          this.log.info({ tiendaIdNube, n: items.length }, 'outbox: flushed OK');
        } else {
          // Buscamos el attempts de la primera fila original del outbox
          // para escalar el backoff.
          const originalAttempts = pending.find((p) => p.tiendaId === tiendaIdNube)?.attempts ?? 0;
          const backoff = Math.min(
            this.cfg.sync.backoffMaxMs / 1000,
            (this.cfg.sync.backoffMinMs / 1000) * Math.pow(2, originalAttempts + 1),
          );
          this.store.scheduleOutboxRetry(
            items.map((i) => i.id),
            backoff,
            `${res.errores}/${items.length} errores`,
          );
          this.log.warn({ tiendaIdNube, err: res.errores }, 'outbox: con errores, retry programado');
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        const backoff = Math.min(
          this.cfg.sync.backoffMaxMs / 1000,
          (this.cfg.sync.backoffMinMs / 1000) * Math.pow(2, 1),
        );
        this.store.scheduleOutboxRetry(items.map((i) => i.id), backoff, (err as Error).message);
        this.log.warn({ tiendaIdNube, err: (err as Error).message }, 'outbox: transient error');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
