import { Injectable, Logger } from '@nestjs/common';
import { forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import { AdminService } from '../../pedidos/admin/admin.service';
import { PedidoStateService } from '../../pedidos/core/pedido-state.service';
import type { SyncEventoDto } from '../dto/upload-batch.dto';
import { EstadoPedido } from '@prisma/client';
import type { UserContext } from '../../../types/pedido.types';

/**
 * PedidoPagoHandler: procesa eventos de PEDIDOS que vienen de Firebird
 * (pagos y cancelaciones).
 *
 * Flujo:
 *   - Resuelve el pedidoId en la nube vía ExternalRef(PEDIDO).
 *   - Si el evento indica cancelación (SWCANCEL=TRUE en Firebird) →
 *     transiciona el pedido a CANCELLED con historial.
 *   - Si el evento indica pago (FINALIZADA=TRUE) → delega a
 *     AdminService.marcarComoPagado (que ya hace la transición
 *     PENDING_PAID→PAID, historial, realtime y email PAGO_CONFIRMADO
 *     vía NotificationsService).
 *
 * Depende del trigger TRG_PEDIDOS_SYNC en Firebird. Los ajustes de items
 * (MOVPED) ya NO se sincronizan: el pedido llega a Firebird con cantidades
 * finales confirmadas por bodega en la web (confirmarSurtido → PENDING_PAID).
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
  ) {}

  async procesar(
    evento: SyncEventoDto,
  ): Promise<{ ok: boolean; mensaje?: string }> {
    try {
      const pedidoIdNube = await this.externalRefs.findSystemId(
        'PEDIDOS',
        evento.localId,
        evento.localTiendaId,
      );
      if (!pedidoIdNube) {
        return { ok: true, mensaje: 'PEDIDOS sin mapeo: omitido (se procesará al llegar)' };
      }

      const d = evento.datos as {
        SWCANCEL?: boolean;
        FINALIZADA?: boolean;
        IDFACTURA?: number;
      };

      // Cancelación en Firebird
      if (d.SWCANCEL === true) {
        await this.cancelarPedido(pedidoIdNube);
        return { ok: true, mensaje: 'PEDIDO cancelado en Firebird → CANCELLED en nube' };
      }

      // Pago confirmado en Firebird (FINALIZADA=TRUE)
      if (d.FINALIZADA === true) {
        // C3: idempotencia. Si el evento se procesa dos veces (por retry del
        // agente tras timeout), no queremos reenviar el email PAGO_CONFIRMADO
        // ni crear otra fila en historial_pedido. Si ya está PAID, omitir.
        const pedidoActual = await this.prisma.pedido.findUnique({
          where: { id: pedidoIdNube },
          select: { estado: true, fechaPago: true },
        });
        if (pedidoActual?.estado === EstadoPedido.PAID) {
          this.logger.log(
            `Pedido ${pedidoIdNube} ya estaba PAID (sync idempotente), omitido`,
          );
          return { ok: true, mensaje: 'PEDIDO ya estaba PAID — omitido (idempotente)' };
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
        return { ok: true, mensaje: 'PEDIDO marcado PAID + email enviado' };
      }

      return { ok: true, mensaje: 'PEDIDO sin cambio relevante (SWCANCEL/FINALIZADA intactos)' };
    } catch (err) {
      this.logger.error(
        `Error procesando PEDIDO/${evento.localId}: ${(err as Error).message}`,
      );
      return { ok: false, mensaje: (err as Error).message };
    }
  }

  private async cancelarPedido(pedidoIdNube: number): Promise<void> {
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoIdNube } });
    if (!pedido) return;
    if (pedido.estado === EstadoPedido.CANCELLED) return;

    // Delega en la máquina de estados (PedidoStateService) para que la
    // transición valide TRANSICIONES y ejecute historial + realtime +
    // notificación. Si Firebird intenta cancelar un pedido en un estado
    // terminal (p.ej. COMPLETED), la máquina lo rechaza con 400 en vez de
    // permitir una transición inválida.
    await this.pedidoState.cambiarEstadoPorSistema(pedidoIdNube, EstadoPedido.CANCELLED, {
      observacion: 'Cancelado en Firebird (sincronizado por agente)',
      usuarioNombre: 'AGENT_EXTERNAL',
    });
  }
}
