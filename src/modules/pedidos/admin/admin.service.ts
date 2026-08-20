import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, Prisma, TipoNotificacion } from '@prisma/client';

/**
 * Servicio del dominio ADMIN.
 *
 * Responsabilidad: listar todos los pedidos con filtros, ver detalle
 * completo, eliminar cancelados, ver historial, y confirmar pagos
 * (manual o vía webhook del sistema externo Firebird). El detalle de
 * pedido lo reutiliza `PedidoStateService.obtenerDetalle` para que
 * bodega/cajero/mostrador/cliente vean la misma estructura.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
  ) {}

  async obtenerTodosPedidos(filtros?: {
    tiendaId?: number;
    estado?: EstadoPedido;
    fechaInicio?: Date;
    fechaFin?: Date;
    pagina?: number;
    limite?: number;
  }) {
    const { tiendaId, estado, fechaInicio, fechaFin, pagina = 1, limite = 20 } = filtros || {};
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {};
    if (tiendaId) where.tiendaId = tiendaId;
    if (estado) where.estado = estado;
    if (fechaInicio || fechaFin) {
      where.fechaPedido = {};
      if (fechaInicio) where.fechaPedido.gte = fechaInicio;
      if (fechaFin) where.fechaPedido.lte = fechaFin;
    }

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: { select: { id: true, productoNombre: true, cantidad: true, precioUnitario: true } },
          tienda: { select: { nombre: true } },
          usuario: { select: { nombre: true, email: true } },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    return {
      data: pedidos,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /**
   * Reutiliza el detalle compartido de `PedidoStateService.obtenerDetalle`
   * (que es el mismo que ven bodega, cajero, mostrador y cliente).
   * Mantiene la firma con `usuario?` para no romper controllers que ya
   * lo invocan sin pasarlo (admin sin filtro de tienda).
   */
  obtenerDetalle(pedidoId: number, usuario?: UserContext) {
    return this.state.obtenerDetalle(pedidoId, usuario);
  }

  async eliminarPedidoCancelado(pedidoId: number, usuario: UserContext) {
    // ADMIN only — el controller ya filtra por rol, pero defendemos en service.
    await this.access.cargarYValidar(pedidoId, usuario);
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (pedido.estado !== EstadoPedido.CANCELLED) {
      throw new BadRequestException('Sólo se pueden eliminar pedidos en estado CANCELLED');
    }
    await this.prisma.pedido.delete({ where: { id: pedidoId } });
    return { mensaje: 'Pedido eliminado', pedidoId };
  }

  async obtenerHistorialPedido(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.prisma.historialPedido.findMany({
      where: { pedidoId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async marcarComoPagado(
    pedidoId: number,
    body: { fechaPago?: string; referencia?: string } | undefined,
    usuario: UserContext,
  ) {
    // Validar propiedad: ADMIN o sistema externo. Si es ADMIN humano,
    // validar tienda. Si es el agente externo (no tiene tienda), sólo
    // validar que el pedido exista.
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    if (pedido.estado !== EstadoPedido.PENDING_PAID) {
      throw new BadRequestException(
        `Sólo se marca como pagado un pedido en PENDING_PAID (actual: ${pedido.estado})`,
      );
    }

    if (usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido no pertenece a tu tienda');
    }

    const fechaPago = body?.fechaPago ? new Date(body.fechaPago) : new Date();
    if (isNaN(fechaPago.getTime())) {
      throw new BadRequestException('fechaPago inválido');
    }

    return this.prisma.$transaction(async (tx) => {
      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.PAID,
          fechaPago,
          cajeroAsignadoId: null,
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.PENDING_PAID,
          estadoNuevo: EstadoPedido.PAID,
          observacion:
            body?.referencia
              ? `Pago confirmado (ref: ${body.referencia})`
              : 'Pago confirmado por sistema externo',
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      const pedidoCompleto = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (pedidoCompleto) {
        setImmediate(() => {
          this.notifications
            .enviar(pedidoCompleto, TipoNotificacion.PAGO_CONFIRMADO)
            .catch((err) =>
              this.logger.error(`Error enviando notificación PAGO_CONFIRMADO: ${err.message}`),
            );
        });
      }

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.PENDING_PAID,
        estadoNuevo: EstadoPedido.PAID,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.PENDING_PAID,
        estadoNuevo: EstadoPedido.PAID,
      });

      return pedidoActualizado;
    });
  }
}
