import type { FirebirdClient } from './firebird-client';
import type { CloudClient, PedidoCloud, AckItem } from './cloud-client';
import type { LocalStore } from './checkpoint-store';
import type { Logger } from './logger-types';
import type { AgentConfig } from './config';
import { AuthError, TransientError } from './cloud-client';

/**
 * DOWN-processor: sincroniza Nube -> Firebird (pedidos nuevos).
 *
 * Ciclo:
 *   1. Para cada tienda nube configurada, hace heartbeat.
 *   2. Pregunta a la nube: GET /poll-pedidos?sucursalId=X&limit=N.
 *   3. Por cada pedido: llama GRABAR_PEDIDOS y luego GRABAR_MOVPED por
 *      cada item. Dentro de una transacción Firebird.
 *   4. Acks acumulados → POST /pedidos-ack (un único POST batch).
 *   5. Si la nube está caída → backoff y reintento.
 */

export class DownProcessor {
  constructor(
    private cfg: AgentConfig,
    private fb: FirebirdClient,
    private cloud: CloudClient,
    private store: LocalStore,
    private log: Logger,
  ) {}

  async runOnce(): Promise<{ descargados: number; errores: number }> {
    let totalDescargados = 0;
    let totalErrores = 0;

    await this.flushAckOutbox();

    // Descubrir las tiendas ACTIVAS desde Firebird (TIENDAS.ACTIVO='S').
    // El IDTIENDA local ES el externalId en la nube, así que no hay mapeo.
    const tiendasLocales = await this.fb.query<{ IDTIENDA: number }>(
      `SELECT IDTIENDA FROM TIENDAS WHERE ACTIVO = 'S'`,
    );
    if (tiendasLocales.length === 0) {
      this.log.warn({}, 'down: no hay tiendas activas en Firebird');
      return { descargados: 0, errores: 0 };
    }

    const acksPorTienda = new Map<number, AckItem[]>();

    for (const { IDTIENDA } of tiendasLocales) {
      const tiendaId = IDTIENDA; // == externalId en la nube

      // 1. Heartbeat (best-effort).
      try {
        await this.cloud.heartbeat(tiendaId, this.cfg.service.description ? '1.0.0' : '1.0.0', process.env.COMPUTERNAME);
      } catch (err) {
        if (err instanceof AuthError) {
          this.log.fatal({ err: err.message }, 'down: auth rejected — abortando');
          throw err;
        }
        // Transient: continuar con poll, no es fatal.
        this.log.warn({ tiendaId, err: (err as Error).message }, 'down: heartbeat fallo, continuando');
      }

      // 2. Poll pedidos pendientes.
      let pedidos: PedidoCloud[] = [];
      try {
        pedidos = await this.cloud.pollPedidos(tiendaId, 20);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log.warn({ tiendaId, err: (err as Error).message }, 'down: poll fallo');
        await this.sleep(this.cfg.sync.backoffMinMs);
        continue;
      }

      if (pedidos.length === 0) continue;

      // 3. Por cada pedido, ejecutar GRABAR_PEDIDOS + GRABAR_MOVPED.
      const acks: AckItem[] = [];
      for (const pedido of pedidos) {
        try {
          const resultado = await this.procesarPedido(tiendaId, pedido);
          acks.push({
            pedidoId: pedido.pedidoId,
            agentId: this.cloud.getAgentId(),
            leaseToken: pedido.leaseToken,
            externalIdPEDIDOS: resultado.externalIdPEDIDOS,
            externalFolio: resultado.externalFolio,
            exito: true,
          });
          totalDescargados++;
        } catch (err) {
          const msg = (err as Error).message;
          this.log.error(
            { tiendaId, pedidoId: pedido.pedidoId, err: msg },
            'down: error al bajar pedido',
          );
          acks.push({
            pedidoId: pedido.pedidoId,
            agentId: this.cloud.getAgentId(),
            leaseToken: pedido.leaseToken,
            exito: false,
            error: msg,
          });
          totalErrores++;
        }
      }

      acksPorTienda.set(tiendaId, acks);
    }

    // 4. Encolar y enviar ACKs por tienda.
    for (const [tiendaId, acks] of acksPorTienda.entries()) {
      this.store.enqueueAck(tiendaId, { acks });
    }
    await this.flushAckOutbox();

    return { descargados: totalDescargados, errores: totalErrores };
  }

  /**
   * Procesa un pedido dentro de una transacción Firebird.
   * Si tiene externalIdPEDIDOS previo (reintento), lo pasa a GRABAR_PEDIDOS
   * para que sea idempotente.
   *
   * `tiendaId` es el IDTIENDA local de Firebird, que coincide con el
   * externalId en la nube (clave natural compartida).
   */
  private async procesarPedido(
    tiendaId: number,
    pedido: PedidoCloud,
  ): Promise<{ externalIdPEDIDOS: number; externalFolio: string }> {
    const localTiendaId = tiendaId;

    // Parámetros de negocio configurables (antes hardcodeados =1/'1').
    const localVendedorId = this.cfg.pedidos?.vendedorId ?? 1;
    const localUsuarioId = this.cfg.pedidos?.usuarioId ?? 1;
    const lista = this.cfg.pedidos?.lista ?? '1';

    // Idempotencia: si este pedido ya se insertó en Firebird en un
    // intento previo (el agente crasheó entre el INSERT y el ack), la
    // copia local `pedido_delivery` guarda el IDPEDIDO generado. Pasarlo
    // a GRABAR_PEDIDOS hace un UPDATE en lugar de un INSERT nuevo, lo que
    // evita pedidos duplicados en Firebird.
    //
    // C2 (ago 2026): el backend ahora pre-asigna `pedido.externalIdPEDIDOS`
    // (= 1B + pedido.id nube) al crear el pedido. Esto sobrevive aunque el
    // SQLite local se borre, garantizando que GRABAR_PEDIDOS reciba siempre
    // el mismo ID en reintentos y la SP lo trate como UPDATE idempotente.
    const entregaPrevia = this.store.getPedidoDelivery(tiendaId, pedido.pedidoId);
    const externalId =
      entregaPrevia?.externalIdPEDIDOS ?? pedido.externalIdPEDIDOS ?? 0;
    if (externalId === 0) {
      this.log.warn(
        { pedidoId: pedido.pedidoId, tiendaId },
        'down: pedido sin externalIdPEDIDOS inicial (C2), riesgo de duplicación en Firebird',
      );
    }

    const resultado = await this.fb.transaction(async (tx) => {
      const r1 = await tx.callScalar<{
        PEDIDO_ID: number;
        PEDIDO_FOLIO: string;
        CMENSAJEERROR: string;
      }>(
        `SELECT PEDIDO_ID, PEDIDO_FOLIO, CMENSAJEERROR
         FROM GRABAR_PEDIDOS(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          externalId, // IDPEDIDO (0 = nuevo)
          localTiendaId,
          pedido.numeroPedido.slice(0, 10), // FOLIO CHAR(10)
          pedido.fechaPedido.split('T')[0], // FECHA (DATE)
          0, // IDCLIENTE (0 = pedido sin cliente local mapeado; ajustar)
          pedido.clienteNombre.slice(0, 80),
          (pedido.shippingDireccion ?? '').slice(0, 80),
          '', // CIUDAD
          pedido.clienteNombre.slice(0, 80), // CONTACTO
          (pedido.clienteTelefono ?? '').slice(0, 50),
          pedido.clienteEmail.slice(0, 100),
          localVendedorId,
          (pedido.notas ?? '').slice(0, 2000),
          pedido.total,
          lista,
          localUsuarioId,
        ],
      );

      if (!r1 || r1.CMENSAJEERROR) {
        throw new Error(`GRABAR_PEDIDOS: ${r1?.CMENSAJEERROR ?? 'no rows'}`);
      }

      const pedidoIdLocal = Number(r1.PEDIDO_ID);
      const folioLocal = r1.PEDIDO_FOLIO;

      // Items.
      for (const item of pedido.items) {
        if (item.skip) {
          this.log.warn(
            { pedidoId: pedido.pedidoId, item: item.itemId },
            'down: item sin PrecioCO local, omitido',
          );
          continue;
        }
        const r2 = await tx.callScalar<{ MOVPED_ID: number; CMENSAJEERROR: string }>(
          `SELECT MOVPED_ID, CMENSAJEERROR FROM GRABAR_MOVPED(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            0, // IDMOVPED = nuevo
            pedidoIdLocal,
            item.productoCodigo.slice(0, 16), // CODIGO CHAR(16)
            item.localProductoId,
            item.localCorridaId,
            item.localColorId,
            item.talla.slice(0, 5),
            item.cantidad,
            item.precioUnitario,
          ],
        );
        if (!r2 || r2.CMENSAJEERROR) {
          throw new Error(`GRABAR_MOVPED: ${r2?.CMENSAJEERROR ?? 'no rows'}`);
        }
      }

      this.log.info(
        {
          tiendaId,
          pedidoId: pedido.pedidoId,
          externalIdPEDIDOS: pedidoIdLocal,
          folio: folioLocal,
          items: pedido.items.filter((i) => !i.skip).length,
        },
        'down: pedido bajado a Firebird',
      );

      return { externalIdPEDIDOS: pedidoIdLocal, externalFolio: folioLocal };
    });

    this.store.setPedidoDelivery(
      tiendaId,
      pedido.pedidoId,
      resultado.externalIdPEDIDOS,
      resultado.externalFolio,
    );
    return resultado;
  }

  private async flushAckOutbox(): Promise<void> {
    const pending = this.store.dueAcks(20);
    if (pending.length === 0) return;

    const byStore = new Map<number, typeof pending>();
    for (const ack of pending) {
      const list = byStore.get(ack.tiendaId) ?? [];
      list.push(ack);
      byStore.set(ack.tiendaId, list);
    }

    for (const [tiendaIdNube, entries] of byStore) {
      const acks = entries.flatMap((entry) => entry.payload.acks as AckItem[]);
      try {
        const res = await this.cloud.pedidosAck(tiendaIdNube, acks);
        if (res.errores === 0) {
          this.store.deleteAcks(entries.map((entry) => entry.id));
        } else {
          this.store.scheduleAckRetry(
            entries.map((entry) => entry.id),
            this.cfg.sync.backoffMinMs / 1000,
            `${res.errores} ACKs rechazados`,
          );
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.store.scheduleAckRetry(
          entries.map((entry) => entry.id),
          this.cfg.sync.backoffMinMs / 1000,
          (err as Error).message,
        );
        this.log.warn({ tiendaIdNube, err: (err as Error).message }, 'down: ack outbox fallo');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
