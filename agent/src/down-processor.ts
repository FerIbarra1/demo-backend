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

const AGENT_LOCAL_USER_ID = 1; // usuario del agente en Firebird (configurar según instalación)

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
    const acksPorTienda = new Map<number, AckItem[]>();

    for (const tiendaIdNube of this.cfg.cloud.sucursalIds) {
      // 1. Heartbeat (best-effort).
      try {
        await this.cloud.heartbeat(tiendaIdNube, this.cfg.service.description ? '1.0.0' : '1.0.0', process.env.COMPUTERNAME);
      } catch (err) {
        if (err instanceof AuthError) {
          this.log.fatal({ err: err.message }, 'down: auth rejected — abortando');
          throw err;
        }
        // Transient: continuar con poll, no es fatal.
        this.log.warn({ tiendaIdNube, err: (err as Error).message }, 'down: heartbeat fallo, continuando');
      }

      // 2. Poll pedidos pendientes.
      let pedidos: PedidoCloud[] = [];
      try {
        pedidos = await this.cloud.pollPedidos(tiendaIdNube, 20);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log.warn({ tiendaIdNube, err: (err as Error).message }, 'down: poll fallo');
        await this.sleep(this.cfg.sync.backoffMinMs);
        continue;
      }

      if (pedidos.length === 0) continue;

      // 3. Por cada pedido, ejecutar GRABAR_PEDIDOS + GRABAR_MOVPED.
      const acks: AckItem[] = [];
      for (const pedido of pedidos) {
        try {
          await this.procesarPedido(tiendaIdNube, pedido);
          // Si procesarPedido no lanza, el ack es éxito. Pero precisamos
          // el externalIdPEDIDOS; el helper interno lo guarda en el store.
          const cp = this.store.getCheckpoint(tiendaIdNube);
          acks.push({
            pedidoId: pedido.pedidoId,
            externalIdPEDIDOS: cp?.pedidoExternalId ?? undefined,
            externalFolio: undefined,
            exito: true,
          });
          totalDescargados++;
        } catch (err) {
          const msg = (err as Error).message;
          this.log.error(
            { tiendaIdNube, pedidoId: pedido.pedidoId, err: msg },
            'down: error al bajar pedido',
          );
          acks.push({ pedidoId: pedido.pedidoId, exito: false, error: msg });
          totalErrores++;
        }
      }

      acksPorTienda.set(tiendaIdNube, acks);
    }

    // 4. POST /pedidos-ack en batch por tienda.
    for (const [tiendaIdNube, acks] of acksPorTienda.entries()) {
      try {
        const res = await this.cloud.pedidosAck(acks);
        this.log.info(
          { tiendaIdNube, actualizados: res.actualizados, err: res.errores },
          'down: ack enviado',
        );
      } catch (err) {
        if (err instanceof AuthError) throw err;
        this.log.warn({ tiendaIdNube, err: (err as Error).message }, 'down: ack fallo');
      }
    }

    return { descargados: totalDescargados, errores: totalErrores };
  }

  /**
   * Procesa un pedido dentro de una transacción Firebird.
   * Si tiene externalIdPEDIDOS previo (reintento), lo pasa a GRABAR_PEDIDOS
   * para que sea idempotente.
   */
  private async procesarPedido(tiendaIdNube: number, pedido: PedidoCloud): Promise<void> {
    // Necesitamos el IDTIENDA local (Firebird). Lo deduce del
    // externalIdNube -> externalIdLocal mediante Tienda (en PG).
    // El agente ya tiene la lista de sucursalIds = IDs nube; debemos mapear
    // a IDTIENDA local. Para mantenerlo simple, asumimos que la
    // configuración incluye `localTiendaIds` mapeado 1:1. Esto se puede
    // mejorar leyendo de la nube via endpoint, pero por simplicidad:
    const localTiendaId = this.localTiendaIdFor(tiendaIdNube);
    if (!localTiendaId) {
      throw new Error(`No hay mapeo local para tiendaIdNube=${tiendaIdNube}`);
    }

    const localVendedorId = 1; // ajustar según la tienda

    // Idempotencia: si la nube ya tiene un externalIdPEDIDOS guardado
    // (de un intento previo), úsalo. Si no, deja que Firebird genere.
    const externalId = pedido.externalIdPEDIDOS ?? 0;

    await this.fb.transaction(async (tx) => {
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
          '1', // LISTA (1 = lista 1 por defecto; ajustar si hay mapeo)
          AGENT_LOCAL_USER_ID,
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
            item.localPrecioCOId, // IDPRODUCTO (el agente recibe el ID local via ExternalRef)
            0, // IDCORRIDA (resolver via ExternalRef; simplificado a 0)
            0, // IDCOLOR
            item.talla.slice(0, 5),
            item.cantidad,
            item.precioUnitario,
          ],
        );
        if (!r2 || r2.CMENSAJEERROR) {
          throw new Error(`GRABAR_MOVPED: ${r2?.CMENSAJEERROR ?? 'no rows'}`);
        }
      }

      // Guardar externalIdPEDIDOS en el store local para idempotencia en reintentos.
      this.store.setPedidoExternalId(tiendaIdNube, pedido.pedidoId, pedidoIdLocal);

      this.log.info(
        {
          tiendaIdNube,
          pedidoId: pedido.pedidoId,
          externalIdPEDIDOS: pedidoIdLocal,
          folio: folioLocal,
          items: pedido.items.filter((i) => !i.skip).length,
        },
        'down: pedido bajado a Firebird',
      );
    });
  }

  /**
   * Mapeo tiendaIdNube -> IDTIENDA local Firebird.
   * Por simplicidad se mantiene una correspondencia 1:1 que el operador
   * configura en agent.config.json como `localTiendaIds`. Si no está,
   * abortamos con mensaje claro.
   */
  private localTiendaIdFor(tiendaIdNube: number): number | null {
    const list = (this.cfg as any).firebird?.localTiendaIds as number[] | undefined;
    const mapping = (this.cfg as any).firebird?.tiendaMap as Record<number, number> | undefined;
    if (mapping && mapping[tiendaIdNube] != null) return mapping[tiendaIdNube];
    if (list && list[tiendaIdNube] != null) return list[tiendaIdNube];
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
