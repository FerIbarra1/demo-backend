import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { VentanillasService } from '../../ventanillas/ventanillas.service';
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
  private readonly logger = new Logger(CajeroService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private pedidoState: PedidoStateService,
    private ventanillasService: VentanillasService,
  ) {}

  async obtenerColaVentanilla(
    tiendaId?: number,
    pagina = 1,
    limite = 20,
    canal: 'KIOSKO' | 'WEB' | 'TODOS' = 'KIOSKO',
  ) {
    const where: Prisma.PedidoWhereInput = {
      estado: EstadoPedido.PENDING_PAID,
      cajeroAsignadoId: null,
    };
    if (canal !== 'TODOS') where.canalOrigen = canal;
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
    return this.tomarPedidoCajeroInterno(pedidoId, usuario, true);
  }

  /**
   * Lógica común de tomar un pedido para el cajero.
   * @param emitirRealtime Si false, no emite `pedido.cajero-asignado`
   *   (lo usa `llamarSiguiente` que emite su propio evento `pedido.llamado`).
   */
  private async tomarPedidoCajeroInterno(
    pedidoId: number,
    usuario: UserContext,
    emitirRealtime: boolean,
  ) {
    const pedido = await this.prisma.$transaction(async (tx) => {
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

      if (emitirRealtime) {
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
      }

      return pedidoActualizado;
    });

    return pedido;
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

  /**
   * F11 (ago 2026): "Llamar siguiente" — el cajero presiona el botón, toma el
   * primer pedido KIOSKO en PENDING_PAID sin asignar (FIFO por fechaPedido)
   * y se lo asigna a su ventanilla.
   *
   * Precondiciones:
   *  - El cajero debe tener una ventanilla elegida. Si no, 400.
   *  - Si no hay pedidos en cola, 404 (la cajera verá "No hay turnos").
   *
   * Realtime: emite `pedido.llamado` con el folio + número de ventanilla a
   * `tienda-{id}` para que el TV muestre la alerta bancaria.
   */
  async llamarSiguiente(usuario: UserContext) {
    if (!usuario.tiendaId) {
      throw new BadRequestException('Tu usuario no tiene tienda asignada');
    }

    // 1) Verificar que el cajero tiene ventanilla.
    const ventanilla = await this.ventanillasService.ventanillaDelCajero(
      usuario.userId,
      usuario.tiendaId,
    );
    if (!ventanilla) {
      throw new BadRequestException(
        'Debes elegir una ventanilla antes de llamar al siguiente turno',
      );
    }

    // 2) Buscar el primer pedido KIOSKO sin asignar (FIFO).
    const siguiente = await this.prisma.pedido.findFirst({
      where: {
        tiendaId: usuario.tiendaId,
        estado: EstadoPedido.PENDING_PAID,
        canalOrigen: 'KIOSKO',
        cajeroAsignadoId: null,
      },
      orderBy: { fechaPedido: 'asc' },
    });
    if (!siguiente) {
      throw new NotFoundException('No hay turnos siguientes en la cola');
    }

    // 3) Asignar al cajero (sin emitir `pedido.cajero-asignado` — la alerta
    // bancaria la emitimos nosotros para no duplicar sonidos).
    const pedido = await this.tomarPedidoCajeroInterno(siguiente.id, usuario, false);

    // 4) Realtime: alerta bancaria para el TV + sonido.
    this.realtime.emitToTienda(usuario.tiendaId, 'pedido.cajero-asignado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      cajeroAsignadoId: usuario.userId,
      cajeroAsignadoNombre: usuario.nombre,
    });
    this.realtime.emitToTienda(usuario.tiendaId, 'pedido.llamado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      ventanillaId: ventanilla.id,
      ventanillaNumero: ventanilla.numero,
      cajeroId: usuario.userId,
      cajeroNombre: usuario.nombre,
    });

    this.logger.log(
      `Cajero ${usuario.userId} llamó turno ${pedido.numeroPedido} a ventanilla ${ventanilla.numero}`,
    );

    return {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      ventanillaId: ventanilla.id,
      ventanillaNumero: ventanilla.numero,
    };
  }
}
