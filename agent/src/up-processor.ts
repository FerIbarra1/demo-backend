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

/**
 * Whitelist definitiva de entidades que el agente sincroniza. Cualquier
 * entidad de BANDEJA_SYNC que no esté aquí (p.ej. CONFTIENDAS) se lee
 * como vacía y el backend la marca como "ignorada" para que NUNCA
 * bloquee el checkpoint global.
 */
const ENTIDADES_SOPORTADAS = new Set([
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
  // MOVPED ya no se sincroniza: el pedido llega a Firebird con cantidades
  // finales confirmadas por bodega en la web. Los eventos residuales de
  // BANDEJA_SYNC se suben con datos vacíos y el backend los ignora.
  'TIENDAS',
]);

/**
 * C1 (ago 2026): el checkpoint ahora es POR TIENDA, no global.
 *
 * BANDEJA_SYNC sigue siendo una sola cola global (todas las tiendas
 * comparten la misma BD Firebird), pero avanzamos el watermark por cada
 * tienda nube por separado. Así, si el batch de la tienda A falla pero
 * el de la tienda B tuvo éxito, B avanza su checkpoint y A no.
 *
 * Antes había un GLOBAL_CHECKPOINT_TIENDA=0 que pisaba el checkpoint de
 * la tienda "0" (inexistente) en la nube, y todas las tiendas se
 * quedaban con el último valor visto en `porTienda`. Eso rompía el
 * escalado horizontal y causaba pérdida de progreso por tienda.
 */

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
   *
   * BANDEJA_SYNC es una cola GLOBAL (todas las tiendas comparten la misma
   * BD Firebird), así que hay UN solo checkpoint. Se lee una vez, se
   * agrupan los eventos por tienda nube y se hace un POST por tienda.
   */
  async runOnce(): Promise<{ procesados: number }> {
    // 0. Bootstrap: en el primer arranque (catalogo nunca subido), sube el
    //    catálogo completo (productos, precios, tallas, colores) leyendo
    //    las tablas reales, porque BANDEJA_SYNC solo contiene CAMBIOS y
    //    no habría eventos para los registros que nunca se han tocado.
    //
    //    C1: la marca de bootstrap vive en `meta.bootstrap_catalogo`, NO en
    //    el checkpoint per-tienda. Una vez ejecutado para CUALQUIER tienda,
    //    las demás también tienen el catálogo (mismas tablas globales Firebird).
    if (this.store.getMeta('bootstrap_catalogo') !== '1') {
      const bootstrap = await this.bootstrapCatalogo();
      if (bootstrap > 0) {
        this.log.info({ eventos: bootstrap }, 'up: bootstrap de catálogo completado');
      }
    }

    // 1. Procesar outbox pendiente (lo que se quedó sin subir por
    //    estar la nube caída).
    const pending = this.store.dueOutbox(this.cfg.sync.batchSize);
    if (pending.length > 0) {
      await this.flushOutbox(pending);
    }

    // 2. Sondear BANDEJA_SYNC desde el checkpoint por tienda.
    //
    //    C1: cada tienda nube tiene su propio watermark. Para no perder
    //    eventos de tiendas "rezagadas", leemos desde el MÍNIMO de todos
    //    los checkpoints activos. Las tiendas que ya tienen el evento lo
    //    descartarán al armar `porTienda` (porque su checkpoint >= BANDEJA_ID).
    //
    //    Si no hay tiendas con checkpoint, partimos desde 0 (arranque en frío).
    const desdeId = await this.minimoCheckpointTiendas();
    const eventos = await this.colectar(desdeId);
    if (eventos.length === 0) return { procesados: 0 };

    const hastaId = eventos[eventos.length - 1]._bandejaId;

    // 3. Agrupar por tienda. El `tiendaId` del upload es el IDTIENDA local
    //    de Firebird, que coincide con el externalId en la nube (clave
    //    natural compartida). Los eventos globales (sin localTiendaId) van
    //    a la primera tienda activa; el backend los aplica una sola vez.
    const tiendaGlobal = await this.primeraTiendaActiva();
    if (tiendaGlobal === undefined) {
      this.log.warn({}, 'up: no hay tiendas activas en Firebird, no se sube nada');
      return { procesados: 0 };
    }
    const porTienda = new Map<number, UploadEvent[]>();
    for (const ev of eventos) {
      const tiendaDestino = ev.localTiendaId ?? tiendaGlobal;
      if (!porTienda.has(tiendaDestino)) porTienda.set(tiendaDestino, []);
      porTienda.get(tiendaDestino)!.push(ev);
    }

    // 4. Subir por tienda. C1: el checkpoint ahora avanza POR TIENDA,
    //    dentro del bucle. Si la tienda A falla pero B tuvo éxito, B
    //    avanza su checkpoint y A no.
    let totalProcesados = 0;
    for (const [tiendaIdNube, upload] of porTienda.entries()) {
      try {
        const res = await this.cloud.upload({
          tiendaId: tiendaIdNube,
          hastaBANDEJAId: hastaId,
          eventos: upload,
        });
        totalProcesados += res.procesados;
        if (res.checkpointAvanzado) {
          // OK: avanzar el checkpoint SOLO de esta tienda.
          this.store.setCheckpoint(tiendaIdNube, hastaId);
          this.log.info(
            { tiendaIdNube, hastaId, ok: res.procesados, err: res.errores },
            'up: batch subido OK',
          );
        } else {
          // Errores parciales: NO avanzar este checkpoint. Los eventos fallidos
          // se reprocesarán en el próximo ciclo.
          this.log.warn(
            { tiendaIdNube, ok: res.procesados, err: res.errores },
            'up: batch con errores, checkpoint no avanza para esta tienda',
          );
        }
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
        } else {
          this.log.error({ tiendaIdNube, err: (err as Error).message }, 'up: error inesperado');
        }
      }
    }

    return { procesados: totalProcesados };
  }

  /**
   * Lee BANDEJA_SYNC.ID > :lastCheckpoint, top N. Para cada ID, lee el
   * registro completo de su tabla y resuelve IDTIENDA.
   *
   * La query es GLOBAL (una sola BD central): BANDEJA_SYNC no tiene
   * IDTIENDA y el checkpoint es único. El IDTIENDA se deduce por entidad
   * en el resolver.
   */
  private async colectar(desdeId: number): Promise<Array<UploadEvent & { _bandejaId: number }>> {
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
        eventId: `BANDEJA:${b.ID}:${b.TABLA}:${b.IDTABLA}`,
        bandejaId: b.ID,
        tipo,
        operacion: b.OPERACION as 'I' | 'U' | 'D',
        entidad: b.TABLA,
        localId: b.IDTABLA,
        datos: await this.leerRegistro(b.TABLA, b.IDTABLA),
      };

      // Resolver IDTIENDA. Las entidades globales se emiten una vez;
      // las entidades por tienda deben conservar su ID local.
      const eventoParaResolver = { ...eventoBase } as UploadEvent;
      const idTiendas = this.esGlobal(b.TABLA)
        ? []
        : await this.tiendaResolver.resolverTodas(eventoParaResolver);
      if (idTiendas.length === 0 && !this.esGlobal(b.TABLA)) {
        this.log.warn({ tabla: b.TABLA, localId: b.IDTABLA }, 'up: entidad sin tienda, descartada');
        eventos.push({ ...eventoBase, _bandejaId: b.ID });
        continue;
      }
      for (const idTienda of idTiendas.length === 0 ? [null] : idTiendas) {
        eventos.push({
          ...eventoBase,
          eventId: `BANDEJA:${b.ID}:${b.TABLA}:${b.IDTABLA}:${idTienda ?? 'GLOBAL'}`,
          localTiendaId: idTienda ?? undefined,
          _bandejaId: b.ID,
        });
      }
    }

    return eventos;
  }

  /**
   * Lee el registro completo de la tabla según la entidad del BANDEJA_SYNC.
   *
   * Si la entidad NO está en la whitelist (p.ej. CONFTIENDAS), devuelve {}
   * para que el backend la marque como "ignorada" y el checkpoint global
   * avance igual (nunca bloquear la cola).
   */
  private async leerRegistro(tabla: string, idTabla: number): Promise<Record<string, unknown>> {
    if (!ENTIDADES_SOPORTADAS.has(tabla)) return {};

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
      TIENDAS: 'IDTIENDA',
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
    if (tabla === 'CLITIEN' || tabla === 'CLITIENCXC') {
      const rows = await this.fb.query<{ IDTIENDA: number }>(
        `SELECT IDTIENDA FROM ${tabla} WHERE IDCLIENTETIEN = ?`,
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

  /**
   * Devuelve el IDTIENDA de la primera tienda ACTIVA en Firebird. Se usa
   * como tienda destino para los eventos globales (sin localTiendaId).
   */
  private async primeraTiendaActiva(): Promise<number | undefined> {
    const rows = await this.fb.query<{ IDTIENDA: number }>(
      `SELECT FIRST 1 IDTIENDA FROM TIENDAS WHERE ACTIVO = 'S' ORDER BY IDTIENDA`,
    );
    return rows[0]?.IDTIENDA;
  }

  /**
   * C1: devuelve el MÍNIMO `ultimoBANDEJAId` entre todas las tiendas con
   * checkpoint. Si ninguna tienda tiene checkpoint aún (arranque en frío),
   * devuelve 0 para que `colectar` lea desde el inicio de BANDEJA_SYNC.
   */
  private async minimoCheckpointTiendas(): Promise<number> {
    return this.store.minCheckpointPorTienda();
  }

  /**
   * Carga inicial del catálogo: lee TODAS las tablas de catálogo (no solo
   * BANDEJA_SYNC) y las sube a la nube. Se ejecuta una sola vez (flag en
   * el LocalStore) porque BANDEJA_SYNC solo registra cambios; sin esto los
   * productos/precios que nunca se han tocado jamás llegarían a la nube.
   */
  private async bootstrapCatalogo(): Promise<number> {
    if (this.store.getMeta('bootstrap_catalogo') === '1') return 0;
    const tiendaGlobal = await this.primeraTiendaActiva();
    if (tiendaGlobal === undefined) return 0;

    const globales = ['PRODUCTOS', 'CORRIDAS', 'CORRIDASREN', 'COLORES', 'LINEAS', 'SUBLINEAS'];
    const porTienda = ['PRECIOS', 'PRECIOSCO'];

    const eventos: UploadEvent[] = [];
    let n = 0;

    for (const tabla of globales) {
      const cols = await this.columnas(tabla);
      const rows = await this.fb.query<Record<string, unknown>>(
        `SELECT ${cols} FROM ${tabla}`,
      );
      for (const row of rows) {
        const pk = this.pkDe(tabla);
        const id = Number(row[pk]);
        if (!id) continue;
        eventos.push({
          eventId: `BOOT:${tabla}:${id}`,
          bandejaId: 0,
          tipo: 'CATALOGO',
          operacion: 'I',
          entidad: tabla,
          localId: id,
          datos: row,
        });
        n++;
      }
    }

    for (const tabla of porTienda) {
      const cols = await this.columnas(tabla);
      const rows = await this.fb.query<Record<string, unknown>>(
        `SELECT ${cols} FROM ${tabla}`,
      );
      for (const row of rows) {
        const pk = this.pkDe(tabla);
        const id = Number(row[pk]);
        const idTienda = Number(row['IDTIENDA']);
        if (!id || !idTienda) continue;
        eventos.push({
          eventId: `BOOT:${tabla}:${id}`,
          bandejaId: 0,
          tipo: 'CATALOGO',
          operacion: 'I',
          entidad: tabla,
          localId: id,
          localTiendaId: idTienda,
          datos: row,
        });
        n++;
      }
    }

    // Subir en batches por tienda.
    const porTiendaDest = new Map<number, UploadEvent[]>();
    for (const ev of eventos) {
      const dest = ev.localTiendaId ?? tiendaGlobal;
      if (!porTiendaDest.has(dest)) porTiendaDest.set(dest, []);
      porTiendaDest.get(dest)!.push(ev);
    }
    for (const [tiendaId, batch] of porTiendaDest.entries()) {
      for (let i = 0; i < batch.length; i += this.cfg.sync.batchSize) {
        const chunk = batch.slice(i, i + this.cfg.sync.batchSize);
        try {
          const res = await this.cloud.upload({
            tiendaId,
            hastaBANDEJAId: 0,
            eventos: chunk,
          });
          if (res.errores > 0) {
            this.log.warn(
              { tiendaId, ok: res.procesados, err: res.errores },
              'up: bootstrap con errores parciales',
            );
          }
        } catch (err) {
          if (err instanceof AuthError) throw err;
          this.log.warn(
            { tiendaId, err: (err as Error).message },
            'up: bootstrap falló, se reintentará en el próximo ciclo',
          );
          return 0; // no marcar como hecho; reintentar
        }
      }
    }

    this.store.setMeta('bootstrap_catalogo', '1');
    return n;
  }

  private tipoParaEntidad(entidad: string): 'CATALOGO' | 'CLIENTE' | 'PEDIDO' | 'PAGO' {
    if (entidad.startsWith('CLIENT')) return 'CLIENTE';
    if (entidad === 'PEDIDOS') return 'PAGO';
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
