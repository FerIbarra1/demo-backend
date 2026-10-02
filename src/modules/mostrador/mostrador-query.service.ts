import { Injectable } from '@nestjs/common';
import { Prisma, EstadoPedido, CanalOrigen, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { UserContext } from '../../types/pedido.types';

/**
 * Consultas de lectura de la consola de mostrador.
 *
 * Se extrajeron de `MostradorService`, que era tres servicios en uno: las
 * consultas, las transiciones de estado y la mutación de items tipo POS. Estas
 * cinco no mutan nada — sólo leen y paginan — así que no tienen por qué
 * convivir con las acciones ni con `PedidoStateService`.
 *
 * `obtenerPedido` delega en `PedidoStateService.obtenerDetalle` porque el
 * detalle lo comparten las cinco consolas y su mapeo (items, mensajes,
 * historial) es el mismo para todas.
 */
@Injectable()
export class MostradorQueryService {
  constructor(
    private prisma: PrismaService,
    private pedidoState: PedidoStateService,
  ) {}
  /**
   * Pedidos de la tienda del usuario listos para entregar (PAID o SHIPPED).
   * Paginado y ordenados por fecha de pago ascendente: los más antiguos
   * primero (FIFO) para evitar que se queden en cola mucho tiempo.
   *
   * PR7: si `orden === 'esperando'` (default), los pedidos con aviso
   * de llegada activo (`llegadaAnunciadaAt IS NOT NULL AND
   * llegadaDescartadaAt IS NULL`) van PRIMERO, FIFO entre ellos. El
   * resto mantiene el orden por fechaPago. Sin este orden, el badge
   * "EN TIENDA" en el mostrador pierde sentido — el operador no sabría
   * cuál de los 10 pedidos PAID es el que tiene al cliente esperando.
   */
  async obtenerPedidosListos(
    tiendaId: number,
    pagina = 1,
    limite = 20,
    orden: 'esperando' | 'pago' = 'esperando',
  ) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: { in: [EstadoPedido.PAID, EstadoPedido.SHIPPED] },
    };
    const orderBy: Prisma.PedidoOrderByWithRelationInput[] =
      orden === 'esperando'
        ? [
            // nullsLast simula "avisados primero, resto después".
            { llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } },
            { fechaPago: 'asc' },
            { id: 'asc' },
          ]
        : [{ fechaPago: 'asc' }, { id: 'asc' }];

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
        },
        orderBy,
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Anotar `esperandoDesdeMin` para que la UI del mostrador pueda
    // mostrar "EN TIENDA · hace 2 min" sin recalcular en cliente.
    const ahora = Date.now();
    const data = pedidos.map((p) => ({
      ...p,
      esperandoDesdeMin:
        p.llegadaAnunciadaAt && !p.llegadaDescartadaAt
          ? Math.max(0, Math.floor((ahora - p.llegadaAnunciadaAt.getTime()) / 60_000))
          : null,
    }));

    return {
      data,
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
   *
   * Oct 2026: incluye `EN_MOSTRADOR`. Antes solo buscaba en PAID/SHIPPED, así
   * que el buscador del mostrador era CIEGO a los pedidos que están esperando
   * revisión — justo los que el operador necesita encontrar cuando el cliente
   * llega sin folio. El caso de uso que lo motiva: el cliente llega a tienda,
   * dice su nombre, y el operador no podía encontrarlo.
   */
  async buscarPedidos(q: string, usuario: UserContext, tiendaId?: number) {
    const where: Prisma.PedidoWhereInput = {
      estado: {
        in: [EstadoPedido.EN_MOSTRADOR, EstadoPedido.PAID, EstadoPedido.SHIPPED],
      },
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
   * Cola de pedidos apartados esperando que el cliente los revise.
   *
   * Gate de visibilidad (decisión D5 del plan):
   *   - KIOSKO        → visible SIEMPRE. El pedido se hizo en la tienda, así
   *                     que el cliente está ahí por definición.
   *   - WEB           → visible SÓLO si el cliente ya avisó su llegada
   *                     (`llegadaAnunciadaAt` poblado y no descartado). Sin
   *                     ese aviso el pedido podría estar en casa del cliente;
   *                     mostrador no tiene a quién llamar.
   *
   * Orden: los que ya avisaron llegada PRIMERO (FIFO entre ellos por el
   * momento del aviso), luego el resto por antigüedad. Es el mismo criterio
   * que ya usa `obtenerPedidosListos`, para que el badge "EN TIENDA" no
   * pierda sentido cuando hay varios pedidos en cola.
   */
  async obtenerCola(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: EstadoPedido.EN_MOSTRADOR,
      OR: [
        { canalOrigen: CanalOrigen.KIOSKO },
        {
          canalOrigen: CanalOrigen.WEB,
          llegadaAnunciadaAt: { not: null },
          llegadaDescartadaAt: null,
        },
      ],
    };

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
        },
        orderBy: [
          // nullsLast simula "avisados primero, resto después".
          { llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } },
          { fechaPedido: 'asc' },
          { id: 'asc' },
        ],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Anotar `esperandoDesdeMin` para que la UI muestre "EN TIENDA · hace X min"
    // sin recalcular en cliente (mismo shape que `obtenerPedidosListos`).
    const ahora = Date.now();
    const data = pedidos.map((p) => ({
      ...p,
      esperandoDesdeMin:
        p.llegadaAnunciadaAt && !p.llegadaDescartadaAt
          ? Math.max(0, Math.floor((ahora - p.llegadaAnunciadaAt.getTime()) / 60_000))
          : null,
      // La TV y la consola necesitan saber si hay alguien a quién llamar.
      // Un pedido web sin aviso no debería estar aquí (el gate de arriba lo
      // excluye), así que en la práctica esto es true para todos los WEB.
      clienteEnTienda: Boolean(p.llegadaAnunciadaAt && !p.llegadaDescartadaAt),
    }));

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  /**
   * Oct 2026: pedidos web que están listos pero NADIE ha avisado que llegó.
   *
   * Es la cara visible del contador `sinCliente` del monitor
   * (`mostrador-monitor.service.ts`). Existe porque el gate de D5 esconde
   * estos pedidos de la cola: un cliente web en `EN_MOSTRADOR` sin aviso es
   * invisible, y si llega a tienda sin teléfono o sin el folio, el operador no
   * tenía forma de encontrarlo ni de hacerlo aparecer.
   *
   * El operador los ve aquí, identifica al cliente, y marca la llegada con
   * `marcarLlegada` — momento en el que el pedido pasa a la cola normal con su
   * badge EN TIENDA.
   *
   * Orden: los más viejos primero. Son los que llevan más tiempo atorados sin
   * que nadie los persiga, así que son los que más urge atender.
   */
  async obtenerSinAviso(tiendaId: number, pagina = 1, limite = 20) {
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {
      tiendaId,
      estado: EstadoPedido.EN_MOSTRADOR,
      canalOrigen: CanalOrigen.WEB,
      // Mismo predicado que el contador `sinCliente` del monitor: sin aviso, o
      // con el aviso descartado por el operador (el cliente no estaba).
      OR: [{ llegadaAnunciadaAt: null }, { llegadaDescartadaAt: { not: null } }],
    };

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
        },
        orderBy: [{ fechaPedido: 'asc' }, { id: 'asc' }],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    const ahora = Date.now();
    const data = pedidos.map((p) => ({
      ...p,
      // Mismo nombre que en el monitor, para que la consola y la TV hablen
      // igual de "cuánto lleva esperando este pedido".
      minutosEsperando: Math.max(0, Math.floor((ahora - p.fechaPedido.getTime()) / 60_000)),
    }));

    return {
      data,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }
}
