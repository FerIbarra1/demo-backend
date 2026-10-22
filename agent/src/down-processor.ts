import type { FirebirdClient } from './firebird-client';
import type { CloudClient, PedidoCloud, AckItem } from './cloud-client';
import type { LocalStore } from './checkpoint-store';
import type { Logger } from './logger-types';
import type { AgentConfig } from './config';
import { AuthError, TransientError } from './cloud-client';
import { esFolio, notasParaErp, reservarFolioConReintentos } from './folio';

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

    // Oct 2026 (parte B): el FOLIO del ERP. Antes se mandaba `numeroPedido.slice(0,10)`: TODO pedido web quedaba con el
    // folio "PD-2026-00" en el Sistema Comercial. Ahora, por orden de prioridad:
    //   1. El que este agente ya grabó en un intento anterior (si el SQLite lo recuerda): lo que está en el ERP manda.
    //   2. El que la nube tiene para el pedido (lo reservó `FolioProcessor` al cerrar el surtido).
    //   3. Uno que este agente ya tomó para ese pedido y no llegó a grabar (se lo guardó en el SQLite).
    //   4. Ninguno (el agente estaba caído al cerrar, un atajo del admin…): se toma el siguiente de `CONSECUTIVOS`.
    //      Va en su PROPIA transacción corta, ANTES de la de `GRABAR_PEDIDOS`: dentro de ella el candado sobre la fila
    //      del consecutivo duraría todo el grabado del pedido y sus líneas, y las cajas de VFP (que usan esa misma
    //      fila) esperarían o perderían el turno. El costo: si el grabado falla queda un hueco; por eso el número se
    //      guarda local y el reintento lo REUSA en vez de gastar otro.
    let folio: string | null = esFolio(entregaPrevia?.externalFolio)
      ? entregaPrevia!.externalFolio!
      : esFolio(pedido.folio)
        ? pedido.folio
        : this.store.getFolioReservado(tiendaId, pedido.pedidoId, true); // solo vigentes: un folio abandonado NO se graba en el ERP
    if (!folio) {
      folio = await reservarFolioConReintentos(this.fb, localTiendaId, { waitTimeoutSec: 10 });
      this.store.setFolioReservado(tiendaId, pedido.pedidoId, folio);
      this.log.info(
        { tiendaId, pedidoId: pedido.pedidoId, folio },
        'down: el pedido llegó sin folio, se tomó el siguiente de CONSECUTIVOS',
      );
    }
    if (esFolio(entregaPrevia?.externalFolio) && esFolio(pedido.folio) && entregaPrevia!.externalFolio !== pedido.folio) {
      this.log.warn(
        { pedidoId: pedido.pedidoId, enErp: entregaPrevia!.externalFolio, enNube: pedido.folio },
        'down: la nube tiene otro folio que el ya grabado en el ERP; manda el del ERP',
      );
    }

    const resultado = await this.fb.transaction(async (tx) => {
      const r1 = await tx.callScalar<{
        PEDIDO_ID: number;
        PEDIDO_FOLIO: string;
        CMENSAJEERROR: string;
      }>(
        // Dos defectos que solo se ven contra el Firebird real (la transacción de mentira de los tests los esconde):
        //  1. GRABAR_PEDIDOS recibe 16 parámetros (IDPEDIDO … IDUSUARIO) y este SQL declaraba 15 `?`: "Input
        //     parameter mismatch".
        //  2. Es un procedimiento EJECUTABLE (no tiene SUSPEND): `SELECT … FROM GRABAR_PEDIDOS(…)` da "not
        //     selectable". Se llama con EXECUTE PROCEDURE, que devuelve UNA fila (ver `callScalar`).
        // Con los dos, NINGÚN pedido de la web llegaba al Sistema Comercial.
        `EXECUTE PROCEDURE GRABAR_PEDIDOS(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          externalId, // IDPEDIDO (0 = nuevo)
          localTiendaId,
          folio, // FOLIO CHAR(10): el del ERP (ver arriba)
          pedido.fechaPedido.split('T')[0], // FECHA (DATE)
          0, // IDCLIENTE (0 = pedido sin cliente local mapeado; ajustar)
          pedido.clienteNombre.slice(0, 80),
          (pedido.shippingDireccion ?? '').slice(0, 80),
          '', // CIUDAD
          pedido.clienteNombre.slice(0, 80), // CONTACTO
          (pedido.clienteTelefono ?? '').slice(0, 50),
          pedido.clienteEmail.slice(0, 100),
          localVendedorId,
          // Origen WEB visible desde VFP: "WEB PD-2026-000123 | notas del cliente". El IDPEDIDO ≥ 1 000 000 000 ya lo
          // marca para quien consulta la BD; esto es lo que se lee en pantalla.
          notasParaErp(pedido.numeroPedido, pedido.notas),
          pedido.total,
          lista,
          localUsuarioId,
        ],
      );

      if (!r1 || r1.CMENSAJEERROR) {
        throw new Error(`GRABAR_PEDIDOS: ${r1?.CMENSAJEERROR ?? 'no rows'}`);
      }

      const pedidoIdLocal = Number(r1.PEDIDO_ID);
      // El folio es CHAR(10): Firebird lo devuelve relleno de espacios ("PD-2026-00 "). La nube lo guarda tal cual
      // llega (VARCHAR) y lo imprime en correos y en el buscador: se recorta aquí.
      const folioLocal = String(r1.PEDIDO_FOLIO ?? '').trim();
      if (folio && folioLocal !== folio) {
        // No debería pasar: con IDPEDIDO ≠ 0 el procedimiento escribe el FOLIO que se le manda. Si pasa, el ACK lleva lo
        // que quedó en el ERP (que es lo que manda) y la nube se ajusta.
        this.log.warn(
          { pedidoId: pedido.pedidoId, mandado: folio, enErp: folioLocal },
          'down: GRABAR_PEDIDOS devolvió un folio distinto al que se le mandó',
        );
      }

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
          `EXECUTE PROCEDURE GRABAR_MOVPED(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // El folio reservado (por el respaldo, o por `FolioProcessor`) ya quedó escrito en el ERP y la nube lo sabrá por el
    // ACK de este pedido: no hay nada que confirmarle aparte. Sin esto el agente seguía reenviando a la nube, cada
    // ciclo, un folio de un pedido que ella no pidió (el respaldo no tiene solicitud) y que rechazaba una y otra vez.
    this.store.confirmarFolio(tiendaId, pedido.pedidoId);
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
