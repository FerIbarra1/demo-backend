import type { FirebirdClient } from './firebird-client';
import type { CloudClient, FolioAck } from './cloud-client';
import type { LocalStore } from './checkpoint-store';
import type { Logger } from './logger-types';
import { AuthError } from './cloud-client';
import { reservarFolioConReintentos } from './folio';

/** Cuánto esperar a que VFP suelte la fila de `CONSECUTIVOS` antes de rendirse (la nube reintenta a los 30 s). */
const ESPERA_CONSECUTIVO_SEG = 10;
/** Cuántas veces se vuelve a mandar a la nube un folio que ella rechazó antes de abandonarlo. */
const MAX_RECHAZOS = 10;

/**
 * FOLIO-processor (oct 2026, parte B): atiende las solicitudes de folio de la nube.
 *
 * Cuando bodega cierra el surtido de un pedido, la nube necesita su folio REAL del Sistema Comercial (va en el ticket y
 * en el QR). Ella no puede llamar al agente, así que deja la solicitud y el agente la recoge aquí:
 *
 *   1. GET  poll-folios  → los pedidos que esperan folio.
 *   2. UPDATE CONSECUTIVOS … RETURNING (transacción propia y corta): toma el número.
 *   3. Lo guarda en SU SQLite antes de avisar. Un número tomado no se devuelve: si el ACK falla, el siguiente ciclo
 *      reusa este mismo en vez de gastar otro.
 *   4. POST folios-ack.
 *
 * NO escribe el pedido en el ERP (eso lo hace `DownProcessor` cuando mostrador lo manda a pagar, con este folio). Un
 * folio de un pedido que luego se cancela queda como hueco en la numeración: aceptado por el dueño.
 *
 * Corre ANTES que `DownProcessor` en cada ciclo, para que un pedido que acaba de recibir folio baje al ERP con él.
 */
export class FolioProcessor {
  constructor(
    private fb: FirebirdClient,
    private cloud: CloudClient,
    private store: LocalStore,
    private log: Logger,
  ) {}

  async runOnce(): Promise<{ reservados: number; errores: number }> {
    let reservados = 0;
    let errores = 0;

    await this.reintentarConfirmaciones();

    const tiendas = await this.fb.query<{ IDTIENDA: number }>(
      `SELECT IDTIENDA FROM TIENDAS WHERE ACTIVO = 'S'`,
    );

    for (const { IDTIENDA: tiendaId } of tiendas) {
      let solicitudes;
      try {
        solicitudes = await this.cloud.pollFolios(tiendaId, 20);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log.warn({ tiendaId, err: (err as Error).message }, 'folios: poll fallo');
        continue;
      }
      if (solicitudes.length === 0) continue;

      const acks: FolioAck[] = [];
      for (const s of solicitudes) {
        const agentId = this.cloud.getAgentId();
        try {
          let folio = this.store.getFolioReservado(tiendaId, s.pedidoId);
          if (folio) {
            this.log.info({ tiendaId, pedidoId: s.pedidoId, folio }, 'folios: reusa el reservado (su ACK no llegó)');
          } else {
            folio = await reservarFolioConReintentos(this.fb, tiendaId, {
              waitTimeoutSec: ESPERA_CONSECUTIVO_SEG,
            });
            this.store.setFolioReservado(tiendaId, s.pedidoId, folio);
            this.log.info({ tiendaId, pedidoId: s.pedidoId, folio }, 'folios: reservado en CONSECUTIVOS');
          }
          acks.push({ pedidoId: s.pedidoId, agentId, exito: true, folio });
          reservados++;
        } catch (err) {
          const msg = (err as Error).message;
          this.log.error({ tiendaId, pedidoId: s.pedidoId, err: msg }, 'folios: no se pudo reservar');
          acks.push({ pedidoId: s.pedidoId, agentId, exito: false, error: msg });
          errores++;
        }
      }

      try {
        const res = await this.cloud.foliosAck(tiendaId, acks);
        // Si la nube rechazó alguno no se sabe cuál: los reservados quedan "por confirmar" y `reintentarConfirmaciones`
        // los manda de uno en uno para aislar al rechazado. Si no rechazó ninguno, todos quedan confirmados.
        if (res.errores === 0) {
          for (const a of acks) if (a.exito) this.store.confirmarFolio(tiendaId, a.pedidoId);
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        // Sin red: el folio ya está en el SQLite, se confirma en el siguiente ciclo.
        this.log.warn({ tiendaId, err: (err as Error).message }, 'folios: ack fallo, se reintenta');
      }
    }

    return { reservados, errores };
  }

  /**
   * Manda a la nube, de uno en uno, los folios que reservó y ella aún no confirmó (sin red en su momento, o rechazados).
   * De uno en uno para que un rechazo no arrastre a los demás.
   */
  private async reintentarConfirmaciones(): Promise<void> {
    for (const r of this.store.foliosSinConfirmar()) {
      try {
        const res = await this.cloud.foliosAck(r.tiendaId, [
          { pedidoId: r.pedidoId, agentId: this.cloud.getAgentId(), exito: true, folio: r.folio },
        ]);
        if (res.errores === 0) {
          this.store.confirmarFolio(r.tiendaId, r.pedidoId);
        } else {
          this.store.rechazarFolio(r.tiendaId, r.pedidoId, MAX_RECHAZOS);
          this.log.warn(
            { tiendaId: r.tiendaId, pedidoId: r.pedidoId, folio: r.folio, intentos: r.intentos + 1 },
            'folios: la nube rechazó el folio reservado',
          );
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log.warn({ tiendaId: r.tiendaId, err: (err as Error).message }, 'folios: reintento de ack fallo');
        return; // sin red: no tiene caso seguir con los demás
      }
    }
  }
}
