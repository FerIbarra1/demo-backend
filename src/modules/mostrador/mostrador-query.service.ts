import { Injectable, ForbiddenException } from '@nestjs/common';
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
      estado: { in: [EstadoPedido.PAGADO, EstadoPedido.ENVIADO] },
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
          // Oct 2026: sin `pendienteEnvio` el folio visible del frontend cae a
          // "Pedido #id" (`lib/utils/folio.ts`) y la lista muestra un número
          // que el cliente no reconoce. Es el folio de VFP, el del ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
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
   * Búsqueda del operador de mostrador. Es el caso de uso central de la
   * consola: un cliente llega a tienda SIN el ticket y SIN el número de
   * pedido, dice su nombre, y el operador tiene que encontrarlo.
   *
   * Oct 2026 — tres arreglos que la hacían inservible justo en ese escenario:
   *
   * 1. **Cubría 3 de los 10 estados.** Filtraba `REVISADO | PAID |
   *    SHIPPED`, así que un pedido que todavía está en bodega, esperando que
   *    el cliente apruebe una propuesta, en asesoría o ya en caja NO SE
   *    ENCONTRABA — y el operador se quedaba sin salida con el cliente
   *    enfrente. Ahora busca en todos los estados, incluidos los terminales:
   *    poder decir "ese pedido ya se lo entregamos" es parte del trabajo.
   *
   * 2. **No buscaba el folio que el cliente conoce.** El cliente trae el folio
   *    de VFP (`externalFolio`); el buscador solo miraba `numeroPedido`, que es
   *    interno e invisible para él (ver `lib/utils/folio.ts` en el frontend).
   *    También se agregó el correo, que es lo que el cliente dicta cuando no
   *    recuerda su teléfono.
   *
   * 3. **El orden enterraba los pedidos accionables.** Ordenaba por
   *    `fechaPago asc`, y los pedidos en `REVISADO` tienen `fechaPago`
   *    NULL — Postgres los manda al final. Con el `take: 20` fijo, el pedido
   *    que el operador necesitaba podía quedar cortado. Ahora ordena por el
   *    enum de estado, que está declarado en orden de ciclo de vida: los
   *    activos primero, los terminales al final. Dentro de cada estado, el más
   *    reciente primero (el cliente que acaba de llegar).
   *
   * El `include` de `pendienteEnvio` no es cosmético: sin él, `folioVisible()`
   * del frontend cae a `"Pedido #id"` y el operador lee un número que el
   * cliente no reconoce.
   */
  async buscarPedidos(
    q: string,
    usuario: UserContext,
    tiendaId?: number,
    pagina = 1,
    limite = 20,
  ) {
    // La tienda sale SOLO del JWT (`user.tiendaId`), nunca de un header. Antes
    // el filtro era `if (rol !== ADMIN && tiendaId)`: un usuario sin tienda
    // quedaba SIN filtro y veía pedidos de todas las tiendas. Falla cerrado,
    // igual que `PedidoAccessService.validar`.
    const where: Prisma.PedidoWhereInput = {};
    if (usuario.rol !== RolUsuario.ADMIN) {
      if (!tiendaId) {
        throw new ForbiddenException(
          'Tu usuario no tiene tienda asignada. Contacta al administrador.',
        );
      }
      where.tiendaId = tiendaId;
    }

    where.OR = [
      { numeroPedido: { contains: q, mode: 'insensitive' } },
      { clienteNombre: { contains: q, mode: 'insensitive' } },
      { clienteEmail: { contains: q, mode: 'insensitive' } },
      // El folio de VFP vive en la tabla de encolado, no en `pedidos`. Solo
      // existe para pedidos ya liberados (los que entraron al ERP).
      { pendienteEnvio: { externalFolio: { contains: q, mode: 'insensitive' } } },
    ];

    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: true,
          tienda: true,
          usuario: { select: { nombre: true, telefono: true, email: true } },
          // El folio que el cliente trae en el ticket. Sin esto la UI muestra
          // "Pedido #id" y el operador no puede confirmar con el cliente.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
        },
        // El enum está declarado en orden de ciclo de vida (activos primero,
        // terminales al final), así que ordenar por él pone arriba lo que el
        // operador puede resolver ahora. Dentro de cada estado, el más reciente.
        orderBy: [{ estado: 'asc' }, { fechaPedido: 'desc' }, { id: 'desc' }],
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    // Oct 2026: anotar `esperandoDesdeMin` igual que `obtenerPedidosListos` y
    // `obtenerCola`. Sin esto, el badge "EN TIENDA · N min" del buscador nunca
    // se pintaba: `BadgeEnTienda` devuelve `null` cuando el campo es
    // `undefined`, así que un pedido con aviso vigente se veía igual que uno
    // sin aviso — justo la distinción que el operador necesita.
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
      // F18 (oct 2026): la cola incluye REVISADO **y EN_ATENCION**.
      //
      // Bug que arregla: `llamar` mueve el pedido a EN_ATENCION, pero NINGUNA
      // pestaña de la consola lo mostraba (esta filtraba REVISADO,
      // `obtenerSinAviso` filtraba REVISADO, `obtenerPedidosListos` filtraba
      // PAGADO|ENVIADO). El operador llamaba a un cliente y el pedido
      // DESAPARECÍA de la consola: no podía hacer el recuento, ni enviarlo a
      // pagar, ni resolver una propuesta. Solo le quedaba "Volver a la lista".
      //
      // Incluirlo aquí es correcto además por semántica: "Por revisar" es la
      // cola de trabajo del operador, y un pedido que ya está atendiendo sigue
      // siendo su trabajo.
      estado: { in: [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION] },
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
          // Oct 2026: el folio de VFP, el que el cliente trae en el ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
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
   * estos pedidos de la cola: un cliente web en `REVISADO` sin aviso es
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
      estado: EstadoPedido.REVISADO,
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
          // Oct 2026: el folio de VFP, el que el cliente trae en el ticket.
          pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
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
