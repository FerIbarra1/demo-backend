import type { FirebirdClient } from './firebird-client';
import type { CloudClient, ConciliacionItem, ConciliacionResultado } from './cloud-client';
import type { Logger } from './logger-types';
import type { AgentConfig } from './config';
import { AuthError } from './cloud-client';

/**
 * CONCILIACIÓN ACTIVA (oct 2026): cada cierto tiempo el agente le pregunta a la nube qué pedidos de cada tienda ya viven
 * en el Sistema Comercial, lee su estado REAL en `PEDIDOS` (SWCANCEL, FINALIZADA, TTOTAL) y se lo devuelve. La nube
 * compara, corrige solo el cobro/cancelación que no supo y deja registro de lo demás.
 *
 * Por qué además del trigger: `TRG_PEDIDOS_SYNC` avisa de los CAMBIOS. Si un evento se pierde, el agente estuvo caído una
 * noche, el trigger no estaba instalado o alguien tocó la fila con el trigger desactivado, el cobro hecho en el Sistema
 * Comercial nunca llega y el pedido se queda por pagar. Esto compara el resultado, no el aviso.
 *
 * Es de SOLO LECTURA sobre Firebird. No guarda estado: si el agente reinicia, la próxima pasada empieza de cero.
 */

const PAGINA = 200;
/** Parámetros por consulta `IN (...)`: Firebird admite hasta 1499 elementos; se queda muy por debajo. */
const POR_CONSULTA = 100;
/** La primera pasada espera a que el bootstrap y el primer ciclo hayan corrido. */
const ESPERA_INICIAL_MS = 30_000;
const INTERVALO_POR_DEFECTO_MS = 10 * 60_000;

export interface ResumenConciliacion {
  ejecutada: boolean;
  revisados: number;
  curados: number;
  hallazgosAbiertos: number;
  tareasCerradas: number;
}

export class ConciliacionProcessor {
  private proximaAt: number;

  constructor(
    private cfg: AgentConfig,
    private fb: FirebirdClient,
    private cloud: CloudClient,
    private log: Logger,
    ahora: number = Date.now(),
  ) {
    this.proximaAt = ahora + ESPERA_INICIAL_MS;
  }

  private get intervaloMs(): number {
    return this.cfg.sync.conciliacionIntervalMs ?? INTERVALO_POR_DEFECTO_MS;
  }

  /** Corre la pasada completa si ya toca. Lo llama el ciclo principal; nunca lanza salvo `AuthError`. */
  async runIfDue(ahora: number = Date.now()): Promise<ResumenConciliacion> {
    const vacio = { ejecutada: false, revisados: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 };
    if (this.intervaloMs <= 0 || ahora < this.proximaAt) return vacio;
    this.proximaAt = ahora + this.intervaloMs;
    try {
      return await this.runOnce();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      this.log.warn({ err: (err as Error).message }, 'conciliación: la pasada falló, se reintenta en el próximo turno');
      return vacio;
    }
  }

  /** Todas las tiendas activas de Firebird, una por una. */
  async runOnce(): Promise<ResumenConciliacion> {
    const tiendas = await this.fb.query<{ IDTIENDA: number }>(
      `SELECT IDTIENDA FROM TIENDAS WHERE ACTIVO = 'S' ORDER BY IDTIENDA`,
    );
    const total: ResumenConciliacion = { ejecutada: true, revisados: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 };

    for (const { IDTIENDA } of tiendas) {
      try {
        const r = await this.deTienda(IDTIENDA);
        total.revisados += r.revisados;
        total.curados += r.curados;
        total.hallazgosAbiertos += r.hallazgosAbiertos;
        total.tareasCerradas += r.tareasCerradas;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        const status = (err as { response?: { status?: number } }).response?.status;
        // La nube no tiene esa tienda (no se ha dado de alta): no hay nada que conciliar, y no es un error.
        if (status === 404) continue;
        this.log.warn({ tiendaId: IDTIENDA, err: (err as Error).message }, 'conciliación: la tienda falló');
      }
    }

    if (total.curados > 0 || total.hallazgosAbiertos > 0 || total.tareasCerradas > 0) {
      this.log.warn(total, 'conciliación: la nube y el Sistema Comercial NO coincidían (se corrigió lo que se pudo)');
    } else {
      this.log.info({ revisados: total.revisados }, 'conciliación: sin diferencias');
    }
    return total;
  }

  private async deTienda(tiendaId: number): Promise<ConciliacionResultado> {
    const suma: ConciliacionResultado = { revisados: 0, desconocidos: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 };
    let despues = 0;
    // Tope de páginas: una nube que devolviera siempre el mismo cursor no debe dejar al agente girando para siempre.
    for (let pagina = 0; pagina < 200; pagina++) {
      const lote = await this.cloud.conciliacionPendientes(tiendaId, PAGINA, despues);
      if (lote.pedidos.length > 0) {
        const items = await this.leerErp(lote.pedidos.map((p) => p.externalIdPEDIDOS));
        const r = await this.cloud.conciliar({ tiendaId, pedidos: items });
        suma.revisados += r.revisados;
        suma.desconocidos += r.desconocidos;
        suma.curados += r.curados;
        suma.hallazgosAbiertos += r.hallazgosAbiertos;
        suma.tareasCerradas += r.tareasCerradas;
      } else if (pagina === 0) {
        // Sin pedidos que verificar también se avisa: la nube anota "se comparó a esta hora, 0 revisados".
        await this.cloud.conciliar({ tiendaId, pedidos: [] });
      }
      if (lote.siguiente == null || lote.siguiente <= despues) break;
      despues = lote.siguiente;
    }
    return suma;
  }

  /** El estado real de esos pedidos en Firebird. Un IDPEDIDO que no vuelve es una fila que ya no existe. */
  async leerErp(ids: number[]): Promise<ConciliacionItem[]> {
    const encontrados = new Map<number, ConciliacionItem>();
    for (let i = 0; i < ids.length; i += POR_CONSULTA) {
      const trozo = ids.slice(i, i + POR_CONSULTA);
      const filas = await this.fb.query<{
        IDPEDIDO: number;
        SWCANCEL: unknown;
        FINALIZADA: unknown;
        TTOTAL: unknown;
        IDFACTURA: unknown;
      }>(
        `SELECT IDPEDIDO, SWCANCEL, FINALIZADA, TTOTAL, IDFACTURA FROM PEDIDOS WHERE IDPEDIDO IN (${trozo.map(() => '?').join(', ')})`,
        trozo,
      );
      for (const f of filas) {
        encontrados.set(Number(f.IDPEDIDO), {
          externalIdPEDIDOS: Number(f.IDPEDIDO),
          existe: true,
          swcancel: esVerdadero(f.SWCANCEL),
          finalizada: esVerdadero(f.FINALIZADA),
          total: f.TTOTAL == null ? null : Number(f.TTOTAL),
          idfactura: f.IDFACTURA == null ? null : Number(f.IDFACTURA),
        });
      }
    }
    return ids.map(
      (id) =>
        encontrados.get(id) ?? {
          externalIdPEDIDOS: id,
          existe: false,
          swcancel: false,
          finalizada: false,
          total: null,
          idfactura: null,
        },
    );
  }
}

/** Firebird 3 devuelve BOOLEAN como booleano; un `SMALLINT`/`CHAR` heredado llegaría como 1 / 'S'. */
function esVerdadero(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'S' || v === 'T';
}
