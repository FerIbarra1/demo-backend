import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { UserContext } from '../../../types/pedido.types';
import { EstadoPedido, Prisma, RolUsuario } from '@prisma/client';

/**
 * Servicio del dominio BODEGA.
 *
 * Responsabilidad: cola de pedidos pendientes, tomar / liberar / marcar
 * como enviado, listar mis pedidos en proceso. Toda transición de estado
 * delega a `PedidoStateService`. El surtido y el monitor viven como
 * services hermanos (`surtido.service.ts`, `monitor.service.ts`) en esta
 * misma carpeta para mantener el dominio cohesivo.
 */
@Injectable()
export class BodegaService {
  private readonly logger = new Logger(BodegaService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private state: PedidoStateService,
    private access: PedidoAccessService,
  ) {}

  async obtenerPedidosBodega(
    tiendaId?: number,
    estado?: EstadoPedido,
    pagina = 1,
    limite = 20,
    estados?: EstadoPedido[],
    soloLibres?: boolean,
  ) {
    const where: Prisma.PedidoWhereInput = {};
    if (tiendaId) where.tiendaId = tiendaId;
    if (estados && estados.length > 0) {
      where.estado = { in: estados };
    } else if (estado) {
      where.estado = estado;
    } else {
      where.estado = {
        in: [EstadoPedido.PENDING_REVIEW, EstadoPedido.REVIEWING],
      };
    }
    if (soloLibres) {
      where.asignadoAId = null;
    }
    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          asignadoA: { select: { id: true, nombre: true, apellido: true } },
        },
        orderBy: { fechaPedido: 'asc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);
    const data = pedidos.map((p: any) => {
      const a = p.asignadoA;
      return {
        ...p,
        asignadoANombre: a
          ? `${a.nombre ?? ''} ${a.apellido ?? ''}`.trim() || null
          : null,
      };
    });
    return {
      data,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  async obtenerMisPedidosBodeguero(usuarioId: number, tiendaId?: number, max?: number) {
    const estadosEnProcesoBodega: EstadoPedido[] = [
      EstadoPedido.REVIEWING,
      EstadoPedido.WAITING_CUSTOMER_APPROVAL,
    ];
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where: {
          asignadoAId: usuarioId,
          estado: { in: estadosEnProcesoBodega },
          ...(tiendaId ? { tiendaId } : {}),
        },
        select: {
          id: true,
          numeroPedido: true,
          estado: true,
          canalOrigen: true,
          clienteNombre: true,
          total: true,
          fechaPedido: true,
          asignadoAt: true,
          _count: { select: { items: true } },
        },
        orderBy: { asignadoAt: 'asc' },
      }),
      this.prisma.pedido.count({
        where: {
          asignadoAId: usuarioId,
          estado: { in: estadosEnProcesoBodega },
        },
      }),
    ]);

    return {
      data: pedidos.map((p) => ({
        ...p,
        total: Number(p.total),
        minutosEnProceso: p.asignadoAt
          ? Math.floor((Date.now() - p.asignadoAt.getTime()) / 60000)
          : 0,
      })),
      meta: {
        total,
        limiteMaximo: max ?? 4,
        disponiblesParaTomar: Math.max(0, (max ?? 4) - total),
      },
    };
  }

  async tomarPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    if (pedido.asignadoAId !== null && pedido.asignadoAId !== usuario.userId) {
      const asignado = await this.prisma.usuario.findUnique({
        where: { id: pedido.asignadoAId },
        select: { nombre: true, apellido: true },
      });
      const nombreOtro =
        `${asignado?.nombre ?? ''} ${asignado?.apellido ?? ''}`.trim() ||
        'otro bodeguero';
      throw new ConflictException(
        `Este pedido ya fue tomado por ${nombreOtro}. Pide que lo libere o selecciona otro pedido.`,
      );
    }

    if (pedido.estado === EstadoPedido.REVIEWING) {
      const result = await this.prisma.$transaction(async (tx) => {
        const actualizado = await tx.pedido.update({
          where: { id: pedidoId },
          data: {
            asignadoAId: usuario.userId,
            asignadoAt: new Date(),
          },
        });
        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior: EstadoPedido.REVIEWING,
            estadoNuevo: EstadoPedido.REVIEWING,
            observacion: `Pedido retomado por ${usuario.nombre} (liberado previamente)`,
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });
        return actualizado;
      });
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.asignado', {
        id: pedidoId,
        asignadoAId: usuario.userId,
        asignadoANombre: `${usuario.nombre}`,
      });
      return result;
    }

    const result = await this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.REVIEWING, observacion: 'Pedido tomado por bodega' },
      usuario,
    );

    this.realtime.emitToTienda(pedido.tiendaId, 'pedido.asignado', {
      id: pedidoId,
      asignadoAId: usuario.userId,
      asignadoANombre: `${usuario.nombre}`,
    });

    return result;
  }

  async liberarPedido(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esAdmin = usuario.rol === RolUsuario.ADMIN;
    const esAsignado =
      usuario.rol === RolUsuario.BODEGA && pedido.asignadoAId === usuario.userId;

    if (!esAdmin && !esAsignado) {
      throw new BadRequestException(
        'Sólo el bodeguero asignado al pedido (o un admin) puede liberarlo.',
      );
    }

    if (pedido.estado !== EstadoPedido.REVIEWING) {
      throw new BadRequestException(
        `Sólo se puede liberar un pedido en REVIEWING (actual: ${pedido.estado})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          asignadoAId: null,
          asignadoAt: null,
        },
      });
      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.REVIEWING,
          estadoNuevo: EstadoPedido.REVIEWING,
          observacion: `Pedido liberado por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });
      this.logger.log(
        `Pedido ${pedidoId}: liberado por ${usuario.nombre} (volverá a estar disponible para tomar)`,
      );

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.liberado', {
        id: pedidoId,
        numeroPedido: pedidoActualizado.numeroPedido,
        liberadoPor: usuario.nombre,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.liberado', { id: pedidoId });

      return pedidoActualizado;
    });
  }

  async marcarEnviado(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario, {
      requiereAsignacionBodega: true,
    });
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { shippingDireccion: true },
    });
    if (!pedidoCompleto) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (!pedidoCompleto.shippingDireccion) {
      throw new BadRequestException(
        'Sólo los pedidos a domicilio pasan por "Enviado". Para pedidos de kiosko o web recoger en tienda, entrégalo desde el módulo Mostrador.',
      );
    }
    return this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.SHIPPED, observacion: 'Pedido enviado al cliente' },
      usuario,
    );
  }
}
