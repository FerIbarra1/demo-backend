import { Injectable, Logger } from '@nestjs/common';
import { forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import { AdminService } from '../../pedidos/admin/admin.service';
import { PedidoStateService } from '../../pedidos/core/pedido-state.service';
import { yaFueCobrado } from '../../pedidos/core/cobro.util';
import { RealtimeService } from '../../realtime/realtime.service';
import {
  ACTOR_AGENTE,
  emitirCambioDePago,
  marcarPagoRequiereRevision,
} from '../../pagos/transferencia/hooks';
import {
  esIdPreasignadoPorLaNube,
  pedidoIdDesdeIdPreasignado,
} from '../../pedidos/core/id-pedido-externo.util';
import type { SyncEventoDto } from '../dto/upload-batch.dto';
import { EstadoPedido, TipoTareaErp } from '@prisma/client';
import { cerrarTareasConfirmadasPorEl } from '../../pedidos/core/tareas-erp.util';
import type { UserContext } from '../../../types/pedido.types';

/**
 * Cuánto tiempo se considera "en vuelo" a un pedido que el agente reclamó pero cuyo ACK
 * todavía no se procesó. Cubre el lease (60 s) con holgura para un ACK reintentado.
 */
const VENTANA_ENTREGA_EN_VUELO_MS = 10 * 60_000;

/**
 * Diferencia de total (en pesos) a partir de la cual se avisa que VFP y la nube ya no
 * hablan del mismo monto. Un centavo de redondeo no es una alerta.
 */
const TOLERANCIA_TOTAL = 0.01;

/**
 * PedidoPagoHandler: procesa eventos de PEDIDOS que vienen de Firebird
 * (pagos y cancelaciones).
 *
 * Flujo:
 *   - Resuelve el pedidoId en la nube vía ExternalRef(PEDIDO).
 *   - Si el evento indica cancelación (SWCANCEL=TRUE en Firebird) →
 *     transiciona el pedido a CANCELADO con historial.
 *   - Si el evento indica pago (FINALIZADA=TRUE) → delega a
 *     AdminService.marcarComoPagado (que ya hace la transición
 *     PENDIENTE_PAGO→PAGADO, historial, realtime y email PAGO_CONFIRMADO
 *     vía NotificationsService).
 *
 * Depende del trigger TRG_PEDIDOS_SYNC en Firebird. Los ajustes de items
 * (MOVPED) ya NO se sincronizan: el pedido llega a Firebird con cantidades
 * finales confirmadas por bodega en la web (confirmarSurtido → PENDIENTE_PAGO).
 *
 * ── Oct 2026 (Fase 0 de pagos por transferencia) ─────────────────────────────
 *
 * 1. EL EVENTO DE PAGO YA NO SE PIERDE si llega antes que el ACK del agente.
 *    Antes, un `PEDIDOS` sin mapeo devolvía `ok: true` (→ PROCESADO) y el checkpoint
 *    avanzaba: si la tienda cobraba antes de que el ACK creara el `ExternalRef`, el
 *    `FINALIZADA` se descartaba para siempre y el pedido pagado en VFP se quedaba en
 *    `PENDIENTE_PAGO` en la nube.
 *
 *    OJO — NO es tan simple como devolver `ok: false` para todo lo que no tenga mapeo:
 *    el trigger dispara con TODOS los pedidos de Firebird, y los que se crean
 *    directamente en VFP nunca van a tener mapeo. Reintentarlos a todos dejaría el
 *    checkpoint atorado y llenaría la bandeja de DEAD_LETTER. Por eso solo se reintenta
 *    lo que pueda ser nuestro (ver `resolverPedido`).
 *
 * 2. Un pedido que YA pasó por el cobro (`PAGADO`/`ENVIADO`/`ENTREGADO`) es idempotente.
 *    Ver `cobro.util.ts`.
 *
 * 3. Se AVISA (log + mensaje del evento) cuando VFP y la nube se desfasan: cambió el
 *    total, o VFP desmarcó un cobro. No se corrige solo: decidir cuál manda es una
 *    discusión de negocio, y para eso hay que verlo primero.
 */
@Injectable()
export class PedidoPagoHandler {
  private readonly logger = new Logger(PedidoPagoHandler.name);

  // Usuario sintético que representa al agente. Reutilizamos el patrón
  // del ApiKeyGuard que inyecta `user.rol = 'AGENT'`.
  private static readonly AGENT_USER: UserContext = {
    userId: 0,
    nombre: 'AGENT_EXTERNAL',
    rol: 'AGENT' as UserContext['rol'],
  };

  constructor(
    private prisma: PrismaService,
    private externalRefs: ExternalRefService,
    @Inject(forwardRef(() => AdminService))
    private adminService: AdminService,
    private pedidoState: PedidoStateService,
    // Opcional: solo para avisar a Tesorería en vivo. RealtimeModule es global.
    private realtime?: RealtimeService,
  ) {}

  async procesar(evento: SyncEventoDto): Promise<{ ok: boolean; mensaje?: string }> {
    try {
      const d = evento.datos as {
        SWCANCEL?: boolean;
        FINALIZADA?: boolean;
        IDFACTURA?: number;
        TTOTAL?: number | string | null;
      };
      // Solo estos dos cambios mueven dinero o terminan el pedido. Lo demás
      // (NOTAS, SERIEFAC…) se mira para alertar pero nunca justifica reintentar.
      const esCancelacion = d.SWCANCEL === true;
      const esPago = d.FINALIZADA === true;

      const { pedidoId: pedidoIdNube, posiblementeNuestro } = await this.resolverPedido(
        evento,
        esCancelacion || esPago,
      );
      if (!pedidoIdNube) {
        if ((esCancelacion || esPago) && posiblementeNuestro) {
          // Reintenta con el backoff del inbox (5 intentos, luego DEAD_LETTER, que se
          // puede reprogramar a mano con `POST /sync/admin/events/:id/replay`).
          this.logger.warn(
            `PEDIDOS/${evento.localId} (tienda ${evento.localTiendaId}): ${
              esPago ? 'cobro' : 'cancelación'
            } sin mapeo, pero hay un pedido de la nube en vuelo; se reintenta`,
          );
          return {
            ok: false,
            mensaje: 'PEDIDOS sin mapeo todavía: el ACK del agente aún no llega, se reintenta',
          };
        }
        return {
          ok: true,
          mensaje: 'PEDIDOS sin mapeo: omitido (pedido creado en VFP, no viene de la nube)',
        };
      }

      const pedido = await this.prisma.pedido.findUnique({
        where: { id: pedidoIdNube },
        select: { estado: true, total: true },
      });
      if (!pedido) {
        return { ok: true, mensaje: 'PEDIDOS con mapeo a un pedido que ya no existe: omitido' };
      }

      const alertas = this.alertasDeDesfase(evento, d, pedido);
      for (const alerta of alertas) {
        this.logger.warn(`PEDIDOS/${evento.localId} → pedido ${pedidoIdNube}: ${alerta}`);
      }
      // Oct 2026: si el total cambió en VFP mientras el cliente tiene unas instrucciones de
      // transferencia abiertas, el monto que se le pidió ya puede ser incorrecto. Se BLOQUEA la
      // aprobación hasta que Tesorería lo aclare (no se corrige solo). Un fallo aquí nunca debe
      // afectar el evento de VFP.
      const alertaTotal = alertas.find((a) => a.startsWith('ALERTA_TOTAL'));
      if (alertaTotal && pedido.estado === EstadoPedido.PENDIENTE_PAGO) {
        try {
          const cambio = await marcarPagoRequiereRevision(
            this.prisma,
            pedidoIdNube,
            `${alertaTotal}. El cliente puede haber transferido un monto que ya no es el correcto.`,
            ACTOR_AGENTE,
          );
          if (cambio && this.realtime) emitirCambioDePago(this.realtime, cambio);
        } catch (err) {
          this.logger.error(
            `No se pudo marcar el pago del pedido ${pedidoIdNube} para revisión: ${(err as Error).message}`,
          );
        }
      }

      const conAlertas = (mensaje: string) =>
        alertas.length ? `${mensaje} | ${alertas.join(' | ')}` : mensaje;

      // Cancelación en Firebird
      if (esCancelacion) {
        await this.cancelarPedido(pedidoIdNube);
        // Oct 2026: si la nube ya había cancelado el pedido y alguien lo canceló también en el Sistema Comercial, la
        // tarea "cancelar en el Sistema Comercial" queda cumplida: se cierra sola.
        await cerrarTareasConfirmadasPorEl(this.prisma, pedidoIdNube, TipoTareaErp.CANCELAR_EN_ERP);
        return {
          ok: true,
          mensaje: conAlertas('PEDIDO cancelado en Firebird → CANCELADO en nube'),
        };
      }

      // Pago confirmado en Firebird (FINALIZADA=TRUE)
      if (esPago) {
        // C3: idempotencia. El evento llega más de una vez (retry del agente tras un
        // timeout) y también cuando cambian NOTAS/IDFACTURA de un pedido ya cobrado.
        // No hay que reenviar el correo PAGO_CONFIRMADO, ni escribir otra fila de
        // historial, ni —peor— retroceder un pedido ENVIADO a PAGADO.
        if (yaFueCobrado(pedido.estado)) {
          this.logger.log(
            `Pedido ${pedidoIdNube} ya estaba ${pedido.estado} (sync idempotente), omitido`,
          );
          // Oct 2026: si la nube lo había marcado pagado a mano, esta es la confirmación del ERP: el cajero ya
          // registró el cobro en el Sistema Comercial y la tarea queda cumplida.
          await cerrarTareasConfirmadasPorEl(
            this.prisma,
            pedidoIdNube,
            TipoTareaErp.REGISTRAR_COBRO_EN_ERP,
          );
          return { ok: true, mensaje: conAlertas(`PEDIDO ya estaba ${pedido.estado} — omitido`) };
        }

        // Cobrado en VFP pero cancelado en la nube (p. ej. el cliente canceló desde su
        // cuenta mientras la tienda lo cobraba). No hay transición válida y decidir qué
        // hacer con ese dinero no le toca al sync: se deja en DEAD_LETTER, visible y
        // reprogramable, y se grita en el log.
        if (pedido.estado === EstadoPedido.CANCELADO) {
          this.logger.error(
            `CONFLICTO: el pedido ${pedidoIdNube} se cobró en VFP (PEDIDOS/${evento.localId}) ` +
              'pero está CANCELADO en la nube. Requiere revisión manual.',
          );
          return {
            ok: false,
            mensaje: conAlertas(
              'CONFLICTO: cobrado en VFP pero CANCELADO en la nube; requiere revisión manual',
            ),
          };
        }

        const fechaPago = new Date();
        await this.adminService.marcarComoPagado(
          pedidoIdNube,
          {
            fechaPago: fechaPago.toISOString(),
            referencia: d.IDFACTURA ? `FACTURA-${d.IDFACTURA}` : `MOVCLI-${evento.localId}`,
          },
          PedidoPagoHandler.AGENT_USER,
        );
        return { ok: true, mensaje: conAlertas('PEDIDO marcado PAGADO + email enviado') };
      }

      return {
        ok: true,
        mensaje: conAlertas('PEDIDO sin cambio relevante (SWCANCEL/FINALIZADA intactos)'),
      };
    } catch (err) {
      this.logger.error(`Error procesando PEDIDO/${evento.localId}: ${(err as Error).message}`);
      return { ok: false, mensaje: (err as Error).message };
    }
  }

  /**
   * Encuentra el pedido de la nube al que se refiere un evento de `PEDIDOS`.
   *
   * 1. `ExternalRef` (lo escribe el ACK del agente). El camino normal.
   * 2. El `IDPEDIDO` pre-asignado: el backend lo fija en `1B + pedidoId` al encolar. Si
   *    el evento trae un ID de ese rango, el pedido sale por aritmética (verificando
   *    que existe la fila de la cola para esa tienda y ese ID) sin esperar al ACK.
   * 3. Sin ninguno de los dos, `posiblementeNuestro` dice si vale la pena reintentar:
   *    - ID en el rango pre-asignado → es nuestro seguro; solo falta la fila.
   *    - ID normal pero hay pedidos reclamados por el agente en los últimos minutos y
   *      sin ACK → puede ser uno de ellos (por si `GRABAR_PEDIDOS` genera su propio ID
   *      en vez de respetar el pre-asignado).
   *    - Cualquier otra cosa es un pedido de VFP: se omite sin ruido.
   *
   * Los pasos 2 y 3 solo corren para eventos que importan (cobro/cancelación): el
   * resto de los eventos de pedidos de VFP no justifica ni una consulta de más.
   */
  private async resolverPedido(
    evento: SyncEventoDto,
    importa: boolean,
  ): Promise<{ pedidoId: number | null; posiblementeNuestro: boolean }> {
    const porRef = await this.externalRefs.findSystemId(
      'PEDIDOS',
      evento.localId,
      evento.localTiendaId,
    );
    if (porRef) return { pedidoId: porRef, posiblementeNuestro: true };
    // Sin tienda no se puede acotar la búsqueda: `externalId: undefined` en Prisma
    // significa "sin filtro" y podríamos tomar el pedido de otra tienda.
    if (!importa || evento.localTiendaId == null) {
      return { pedidoId: null, posiblementeNuestro: false };
    }

    const delaTienda = { pedido: { tienda: { externalId: evento.localTiendaId } } };

    if (esIdPreasignadoPorLaNube(evento.localId)) {
      const fila = await this.prisma.pedidoPendienteEnvio.findFirst({
        where: {
          pedidoId: pedidoIdDesdeIdPreasignado(evento.localId),
          externalIdPEDIDOS: evento.localId,
          ...delaTienda,
        },
        select: { pedidoId: true },
      });
      return fila
        ? { pedidoId: fila.pedidoId, posiblementeNuestro: true }
        : { pedidoId: null, posiblementeNuestro: true };
    }

    const enVuelo = await this.prisma.pedidoPendienteEnvio.count({
      where: {
        estado: 'PROCESSING',
        ultimoIntentoAt: { gte: new Date(Date.now() - VENTANA_ENTREGA_EN_VUELO_MS) },
        ...delaTienda,
      },
    });
    return { pedidoId: null, posiblementeNuestro: enVuelo > 0 };
  }

  /**
   * Desfases entre VFP y la nube que alguien debería mirar. NO bloquean el evento ni
   * corrigen nada: son el aviso mínimo mientras se decide cómo reconciliar.
   *
   * El trigger de Firebird ya reportaba estos cambios; el handler los ignoraba:
   *   - `TTOTAL` distinto: la tienda editó el pedido en VFP. Si había una transferencia
   *     pendiente, el cliente puede haber pagado un monto que ya no es el correcto.
   *   - `FINALIZADA = false` en un pedido que la nube ya da por cobrado: VFP reversó el
   *     cobro y la nube sigue diciendo PAGADO.
   *
   * (No se alerta la reversa de `SWCANCEL`: un pedido cancelado desde la nube tiene
   * `SWCANCEL = false` en VFP y cualquier otro evento lo dispararía.)
   */
  private alertasDeDesfase(
    evento: SyncEventoDto,
    d: { FINALIZADA?: boolean; TTOTAL?: number | string | null },
    pedido: { estado: EstadoPedido; total: { toString(): string } },
  ): string[] {
    const alertas: string[] = [];

    if (d.TTOTAL != null && pedido.estado !== EstadoPedido.CANCELADO) {
      const totalVfp = Number(d.TTOTAL);
      const totalNube = Number(pedido.total.toString());
      if (Number.isFinite(totalVfp) && Math.abs(totalVfp - totalNube) > TOLERANCIA_TOTAL) {
        alertas.push(
          `ALERTA_TOTAL: VFP dice $${totalVfp.toFixed(2)} y la nube $${totalNube.toFixed(2)}`,
        );
      }
    }

    if (d.FINALIZADA === false && yaFueCobrado(pedido.estado)) {
      alertas.push(
        `ALERTA_REVERSA: VFP desmarcó el cobro (PEDIDOS/${evento.localId}) pero la nube sigue en ${pedido.estado}`,
      );
    }

    return alertas;
  }

  private async cancelarPedido(pedidoIdNube: number): Promise<void> {
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoIdNube } });
    if (!pedido) return;
    if (pedido.estado === EstadoPedido.CANCELADO) return;

    // Delega en la máquina de estados (PedidoStateService) para que la
    // transición valide TRANSICIONES y ejecute historial + realtime +
    // notificación. Si Firebird intenta cancelar un pedido en un estado
    // terminal (p.ej. ENTREGADO), la máquina lo rechaza con 400 en vez de
    // permitir una transición inválida.
    await this.pedidoState.cambiarEstadoPorSistema(pedidoIdNube, EstadoPedido.CANCELADO, {
      observacion: 'Cancelado por la tienda',
      usuarioNombre: 'AGENT_EXTERNAL',
    });
  }
}
