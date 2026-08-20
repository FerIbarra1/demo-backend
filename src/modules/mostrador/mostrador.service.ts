import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, EstadoPedido, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { UserContext } from '../../types/pedido.types';

/**
 * Módulo Mostrador (jul 2026).
 *
 * Responsabilidad: gestionar la entrega FÍSICA de pedidos ya pagados (o ya
 * enviados) a clientes en tienda. Cualquier usuario MOSTRADOR puede entregar
 * cualquier pedido de su tienda — no hay asignación 1:1 como en el cajero.
 *
 * Estados que el mostrador ve:
 *   - PAID       — pagado, listo para entregar (kiosko/web recoger).
 *   - SHIPPED    — ya enviado por paquetería, el cliente recoge en tienda
 *                  (caso poco común pero soportado por la máquina de estados).
 *
 * Transición que dispara: PAID|SHIPPED → COMPLETED. Toda la lógica de
 * historial, realtime y notificación al cliente se delega a
 * `PedidosService.cambiarEstado` para mantener una sola fuente de verdad.
 */
@Injectable()
export class MostradorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidoState: PedidoStateService,
    private readonly access: PedidoAccessService,
  ) {}

  /**
   * Pedidos de la tienda del usuario listos para entregar (PAID o SHIPPED).
   * Paginado y ordenados por fecha de pago ascendente: los más antiguos
   * primero (FIFO) para evitar que se queden en cola mucho tiempo.
   */
  async obtenerPedidosListos(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: { in: [EstadoPedido.PAID, EstadoPedido.SHIPPED] },
    };
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
        },
        orderBy: [{ fechaPago: 'asc' }, { id: 'asc' }],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    return {
      data: pedidos,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  /**
   * Búsqueda rápida por número exacto o fragmento del nombre del cliente.
   * Restringe a la tienda del usuario (salvo ADMIN).
   */
  async buscarPedidos(q: string, usuario: UserContext, tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      estado: { in: [EstadoPedido.PAID, EstadoPedido.SHIPPED] },
      OR: [
        { numeroPedido: { contains: q, mode: 'insensitive' } },
        { clienteNombre: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (usuario.rol !== RolUsuario.ADMIN && tiendaId) {
      where.tiendaId = tiendaId;
    }
    return this.prisma.pedido.findMany({
      where,
      include: {
        items: true,
        tienda: true,
        usuario: { select: { nombre: true, telefono: true, email: true } },
      },
      orderBy: { fechaPago: 'asc' },
      take: 20,
    });
  }

  /**
   * Detalle completo de un pedido. La validación de tienda/rol la hace
   * `PedidoAccessService` a través de `obtenerDetalle`.
   */
  async obtenerPedido(pedidoId: number, usuario: UserContext) {
    return this.pedidoState.obtenerDetalle(pedidoId, usuario);
  }

  /**
   * Marca un pedido como entregado (PAID|SHIPPED → COMPLETED).
   *
   * Validaciones (defensa en profundidad — el controller también valida rol):
   *   1. El pedido pertenece a la tienda del usuario (ADMIN pasa).
   *   2. El pedido está en PAID o SHIPPED.
   *
   * El frontend ya validó que el operador marcó todos los items como
   * entregados en la UI. Esta capa NO recibe la lista de items
   * confirmados: confía en la decisión humana del mostrador. Si en el
   * futuro se requiere trazabilidad pieza-por-pieza, se puede añadir
   * `itemsVerificados: number[]` al body y persistirlo en
   * `HistorialPedido.observacion`.
   */
  async entregar(pedidoId: number, usuario: UserContext) {
    // 1. Cargar y validar acceso (ADMIN cross-tienda, MOSTRADOR sólo su tienda).
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    // 2. Validar estado.
    if (
      pedido.estado !== EstadoPedido.PAID &&
      pedido.estado !== EstadoPedido.SHIPPED
    ) {
      throw new BadRequestException(
        `Sólo se pueden entregar pedidos en PAID o SHIPPED (actual: ${pedido.estado})`,
      );
    }

    // 3. Delegar al servicio central para transición + historial + realtime
    //    + notificación al cliente (ENTREGADO). La observación incluye el
    //    rol para distinguir en el historial si fue entregado en mostrador
    //    o por bodega en una migración.
    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.COMPLETED,
        observacion: `Entregado en mostrador por ${usuario.nombre}`,
      },
      usuario,
    );
  }
}
