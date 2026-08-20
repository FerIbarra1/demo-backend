import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, Prisma, RolUsuario } from '@prisma/client';

/**
 * Servicio del dominio CAJERO.
 *
 * Responsabilidad: cola de pedidos del kiosko en PENDING_PAID, asignar
 * pedidos a la ventanilla del cajero logueado (1:1), liberar y listar
 * mis pedidos. NO dispara transiciones de estado: sólo cambia la
 * asignación de ventanilla. El cobro se confirma en un sistema externo
 * (Firebird) que llama al webhook `POST /admin/pedidos/:id/marcar-pagado`.
 */
@Injectable()
export class CajeroService {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private pedidoState: PedidoStateService,
  ) {}

  async obtenerColaVentanilla(tiendaId?: number, pagina = 1, limite = 20) {
    const where: Prisma.PedidoWhereInput = {
      estado: EstadoPedido.PENDING_PAID,
      canalOrigen: 'KIOSKO',
      cajeroAsignadoId: null,
    };
    if (tiendaId) where.tiendaId = tiendaId;
    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
        },
        orderBy: { fechaPedido: 'asc' },
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

  async tomarPedidoCajero(pedidoId: number, usuario: UserContext) {
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      if (pedido.canalOrigen !== 'KIOSKO') {
        throw new BadRequestException('Sólo pedidos del kiosko entran al monitor de ventanillas');
      }
      if (pedido.estado !== EstadoPedido.PENDING_PAID) {
        throw new BadRequestException(
          `Sólo se toman pedidos en PENDING_PAID (actual: ${pedido.estado})`,
        );
      }
      if (pedido.cajeroAsignadoId !== null && pedido.cajeroAsignadoId !== usuario.userId) {
        throw new ConflictException('Este pedido ya está asignado a otra ventanilla');
      }
      if (usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
        throw new BadRequestException('El pedido no pertenece a tu tienda');
      }

      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          cajeroAsignadoId: usuario.userId,
          cajeroAsignadoAt: new Date(),
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.PENDING_PAID,
          estadoNuevo: EstadoPedido.PENDING_PAID,
          observacion: `Tomado para ventanilla por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.cajero-asignado', {
        id: pedidoId,
        numeroPedido: pedidoActualizado.numeroPedido,
        cajeroAsignadoId: usuario.userId,
        cajeroAsignadoNombre: usuario.nombre,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.cajero-asignado', {
        id: pedidoId,
        cajeroAsignadoId: usuario.userId,
      });

      return pedidoActualizado;
    });
  }

  async liberarPedidoCajero(pedidoId: number, usuario: UserContext) {
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const esAdmin = usuario.rol === RolUsuario.ADMIN;
      const esAsignado =
        usuario.rol === RolUsuario.CAJERO && pedido.cajeroAsignadoId === usuario.userId;

      if (!esAdmin && !esAsignado) {
        throw new BadRequestException(
          'Sólo el cajero asignado al pedido (o un admin) puede liberarlo.',
        );
      }

      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          cajeroAsignadoId: null,
          cajeroAsignadoAt: null,
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion: `Liberado de ventanilla por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.cajero-liberado', {
        id: pedidoId,
        numeroPedido: pedidoActualizado.numeroPedido,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.cajero-liberado', { id: pedidoId });

      return pedidoActualizado;
    });
  }

  async obtenerMisPedidosCajero(usuarioId: number, tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      cajeroAsignadoId: usuarioId,
      estado: EstadoPedido.PENDING_PAID,
    };
    if (tiendaId) where.tiendaId = tiendaId;

    return this.prisma.pedido.findMany({
      where,
      include: {
        items: true,
        tienda: true,
        usuario: { select: { nombre: true, telefono: true, email: true } },
      },
      orderBy: { cajeroAsignadoAt: 'asc' },
    });
  }
}
