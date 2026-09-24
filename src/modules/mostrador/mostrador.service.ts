import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Prisma, EstadoPedido, RolUsuario, CanalOrigen } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recalcularTotalesPedido } from '../pedidos/core/totales.util';
import { PreciosService } from '../precios/precios.service';
import { precioDeLista, ColumnaLista } from '../precios/precio-lista.util';
import { ItemAjusteDto } from './dto/accion-mostrador.dto';
import { UserContext } from '../../types/pedido.types';

/**
 * Módulo Mostrador (jul 2026).
 *
 * Responsabilidad: gestionar el paso del pedido por mostrador. Cualquier
 * usuario MOSTRADOR puede operar cualquier pedido de su tienda — no hay
 * asignación 1:1 como en el cajero.
 *
 * F16 (sep 2026): el mostrador pasó de ser la ÚLTIMA parada a ser la
 * penúltima. Antes veía pedidos ya pagados y solo entregaba. Ahora:
 *
 *   1. `EN_MOSTRADOR` — el pedido está apartado y el cliente lo revisa en
 *      tienda. El operador decide:
 *        - `liberar`  → PENDING_PAID (AQUÍ entra al ERP: Firebird solo ve
 *                       pedidos que el cliente ya confirmó).
 *        - `ajustar`  → REVIEWING (el cliente pidió cambios; bodega re-surte).
 *        - `cancelar` → CANCELLED + lista de reposición (la mercancía vuelve
 *                       al anaquel).
 *   2. `PAID` / `SHIPPED` — el cliente ya pagó; el operador entrega
 *      (`entregar` → COMPLETED). Esto ya existía y no cambió.
 *
 * Estados que el mostrador ve:
 *   - EN_MOSTRADOR — por revisar con el cliente (nuevo en F16).
 *   - PAID         — pagado, listo para entregar (kiosko/web recoger).
 *   - SHIPPED      — ya enviado por paquetería, el cliente recoge en tienda
 *                    (caso poco común pero soportado por la máquina de estados).
 *
 * Toda transición delega en `PedidoStateService.cambiarEstado` para mantener
 * una sola fuente de verdad de historial, realtime y notificación.
 */
@Injectable()
export class MostradorService {
  private readonly logger = new Logger(MostradorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidoState: PedidoStateService,
    private readonly access: PedidoAccessService,
    private readonly reposicion: ReposicionService,
    private readonly realtime: RealtimeService,
    private readonly precios: PreciosService,
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
      esperandoDesdeMin: p.llegadaAnunciadaAt && !p.llegadaDescartadaAt
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

  // ==================================================================
  // F16 (sep 2026): la cola de EN_MOSTRADOR y las tres acciones del operador
  // ==================================================================

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
  async obtenerCola(
    tiendaId: number,
    pagina = 1,
    limite = 20,
  ) {
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
          ? Math.max(
              0,
              Math.floor((ahora - p.llegadaAnunciadaAt.getTime()) / 60_000),
            )
          : null,
      // La TV y la consola necesitan saber si hay alguien a quién llamar.
      // Un pedido web sin aviso no debería estar aquí (el gate de arriba lo
      // excluye), así que en la práctica esto es true para todos los WEB.
      clienteEnTienda: Boolean(
        p.llegadaAnunciadaAt && !p.llegadaDescartadaAt,
      ),
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
   * `EN_MOSTRADOR → PENDING_PAID`. El cliente revisó su pedido y está de
   * acuerdo: pasa a caja a pagar.
   *
   * **Aquí entra el pedido al ERP.** Es el punto central del cambio de flujo:
   * con el encolado en este momento, Firebird solo ve pedidos que el cliente
   * ya confirmó, y un ajuste o cancelación en mostrador nunca lo deja
   * desincronizado (el pedido todavía no existe allá).
   *
   * `encolarFirebird: true` es obligatorio: un PENDING_PAID sin fila en
   * `PedidoPendienteEnvio` es invisible al agente, nunca recibe folio y se
   * queda atascado para siempre.
   */
  async liberar(pedidoId: number, usuario: UserContext, nota?: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'liberar');

    // Decisión D2 del plan: el operador PUEDE liberar sin que el cliente haya
    // avisado llegada (sabe más que el sistema). Queda registrado para poder
    // auditar cuántas veces se salta el gate.
    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { llegadaAnunciadaAt: true, llegadaDescartadaAt: true },
    });
    const avisoVigente = Boolean(
      completo?.llegadaAnunciadaAt && !completo.llegadaDescartadaAt,
    );
    const sufijoAviso = avisoVigente
      ? ''
      : ' (sin aviso de llegada del cliente)';
    const sufijoNota = nota ? ` — ${nota}` : '';

    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.PENDING_PAID,
        observacion: `Liberado a pago en mostrador por ${usuario.nombre}${sufijoAviso}${sufijoNota}`,
      },
      usuario,
      {
        // Aquí entra al ERP. Ver el comentario del método.
        encolarFirebird: true,
        // La TV de cajero y la de mostrador tienen que recomputar.
        invalidarMonitor: true,
      },
    );
  }

  /**
   * `EN_MOSTRADOR → REVIEWING`. El cliente quiere cambios: el pedido vuelve a
   * la cola de bodega a que se surta lo nuevo.
   *
   * Fase 1 solo registra la intención (la nota). La Fase 4 agrega la edición
   * real de items (agregar/quitar/cambiar cantidades) dentro de `efectos`.
   *
   * `asignacion: 'limpiar'` es obligatorio: el caller es el OPERADOR, no un
   * bodeguero. Con 'caller' el pedido quedaría asignado a un usuario de
   * mostrador, invisible en el monitor de bodega y bloqueado para todos los
   * bodegueros. `cambiarEstado` exige que sea explícito justo por esto.
   *
   * `reloj: 'reanudar'` (no 'pausar'): el pedido vuelve a ser tarea de bodega,
   * así que el reloj de atención arranca un turno nuevo acumulando lo previo.
   * Con 'pausar' el pedido volvería con el reloj congelado y la urgencia
   * mentiría.
   *
   * Fase 4 (sep 2026): acepta los cambios de items del editor POS. Se aplican
   * DENTRO de la transacción de la transición (`efectos`), así que el pedido no
   * puede quedar en REVIEWING con los items a medio aplicar — bodega vería un
   * pedido que no coincide con lo que el cliente pidió.
   *
   * Sin `items`, el comportamiento es el de la Fase 1: solo registra la nota y
   * manda el pedido a bodega. Eso permite desplegar el backend antes que el
   * frontend sin romper nada.
   */
  async ajustar(
    pedidoId: number,
    usuario: UserContext,
    nota: string,
    items?: ItemAjusteDto[],
  ) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'ajustar');

    // El pedido completo se necesita ANTES de la transacción: `PreciosService`
    // usa `prisma` (no el `tx`) y la lista de precios del cliente se resuelve
    // fuera. Además los `efectos` corren dentro del tx, donde no se puede
    // llamar a un service que use otra conexión.
    const pedidoCompleto = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { items: true },
    });
    if (!pedidoCompleto) throw new BadRequestException('Pedido no encontrado');

    const hayCambios = Boolean(items && items.length > 0);

    // Validar ANTES de la transacción para fallar rápido y con mensajes claros.
    if (hayCambios) {
      this.validarAjuste(items!, pedidoCompleto.items);
    }

    // Fase 0: el precio de los productos agregados sale de la lista del cliente
    // que hizo el pedido, no de `pco.precio` (siempre lista1).
    const columnaLista = hayCambios
      ? await this.precios.columnaParaPedido(pedidoCompleto)
      : 'lista1';

    let resumenCambios: string[] = [];

    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.REVIEWING,
        observacion: hayCambios
          ? `Ajuste en mostrador por ${usuario.nombre}: ${nota} (${resumenCambios.length || items!.length} cambio(s))`
          : `Ajuste solicitado en mostrador por ${usuario.nombre}: ${nota}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'reanudar',
        invalidarMonitor: true,
        efectos: hayCambios
          ? async (tx) => {
              resumenCambios = await this.aplicarAjuste(
                tx,
                pedidoCompleto,
                items!,
                columnaLista,
              );
            }
          : undefined,
      },
    );
  }

  /**
   * Aplica los cambios del editor POS sobre los items del pedido.
   *
   * Reglas por tipo:
   *   - `completo`      → no toca nada (el cliente lo dejó igual).
   *   - `parcial`       → cambia la cantidad del item existente.
   *   - `no-disponible` → cancela el item (el cliente ya no lo quiere).
   *   - `agregado`      → crea una línea nueva en PENDIENTE.
   *
   * El `precioUnitario` de los agregados se resuelve desde `PrecioCO` con la
   * lista del cliente — NUNCA se toma del request (un operador podría mandar 0).
   *
   * Los items nuevos nacen en `PENDIENTE` con `original: false`: nadie los ha
   * verificado contra el anaquel, y ese flag es lo que el monitor de bodega usa
   * para marcar el pedido como "vino con cambios" (§3.7 del plan).
   */
  private async aplicarAjuste(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    items: ItemAjusteDto[],
    columnaLista: ColumnaLista,
  ): Promise<string[]> {
    const cambios: string[] = [];
    const idsActuales = new Set(
      (await tx.itemPedido.findMany({
        where: { pedidoId: pedido.id },
        select: { id: true },
      })).map((i) => i.id),
    );

    for (const it of items) {
      if (it.tipo === 'completo') continue;

      if (it.tipo === 'agregado') {
        if (!it.precioCOId) {
          throw new BadRequestException(
            'Un producto agregado requiere precioCOId.',
          );
        }
        const pco = await tx.precioCO.findUnique({
          where: { id: it.precioCOId },
          include: { producto: true, talla: true, color: true, corrida: true },
        });
        if (!pco) {
          throw new BadRequestException(`PrecioCO ${it.precioCOId} no existe`);
        }
        if (pco.tiendaId !== pedido.tiendaId) {
          throw new BadRequestException(
            'El producto agregado pertenece a otra tienda.',
          );
        }

        const cantidad = Math.max(1, it.cantidad ?? 1);
        const precioUnitario = precioDeLista(pco, columnaLista);
        await tx.itemPedido.create({
          data: {
            pedidoId: pedido.id,
            productoId: pco.productoId,
            precioCOId: pco.id,
            cantidad,
            cantidadOriginal: cantidad,
            precioUnitario,
            subtotal: precioUnitario.mul(cantidad),
            productoNombre: pco.producto.nombre,
            productoCodigo: pco.producto.codigo,
            corridaNombre: pco.corrida.nombre,
            tallaNombre: pco.talla.nombre,
            colorNombre: pco.color.nombre,
            // `original: false` — nadie verificó este producto contra el
            // anaquel. Es la señal que bodega usa para saber que el pedido
            // volvió con cambios.
            original: false,
            cancelada: false,
            estadoSurtido: 'PENDIENTE',
            cantidadSurtida: 0,
          },
        });
        cambios.push(`"${pco.producto.nombre}" agregado (${cantidad} pzas)`);
        continue;
      }

      // Tipos que operan sobre un item existente.
      if (it.itemId == null || !idsActuales.has(it.itemId)) {
        throw new BadRequestException(
          `El item ${it.itemId ?? '(sin id)'} no pertenece a este pedido.`,
        );
      }

      if (it.tipo === 'no-disponible') {
        // F16: limpieza completa del estado de surtido al cancelar. Sin esto
        // el item quedaba con `estadoSurtido` viejo (PARCIAL/NO_DISPONIBLE),
        // que es benigno hoy (todos los guards excluyen cancelados) pero
        // normaliza el contrato para futuras validaciones.
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cancelada: true,
            estadoSurtido: 'NO_DISPONIBLE',
            cantidadSurtida: 0,
          },
        });
        cambios.push(`Item #${it.itemId} quitado`);
        continue;
      }

      if (it.tipo === 'parcial') {
        const cantidad = Math.max(1, it.cantidad ?? 1);
        const item = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: {
            precioUnitario: true,
            cantidad: true,
            cantidadSurtida: true,
            estadoSurtido: true,
          },
        });
        if (!item) {
          throw new BadRequestException(`Item ${it.itemId} no existe.`);
        }

        // F16 (sep 2026): el ajuste de cantidad tiene que dejar el item en un
        // estado COHERENTE con lo que bodega verificó físicamente.
        //
        // Antes esta rama solo escribía `cantidad` y `subtotal`, dejando
        // `estadoSurtido: COMPLETO` con el `cantidadSurtida` viejo. Si el
        // cliente SUBÍA la cantidad (2 → 5), el item quedaba "completo" con 2
        // piezas apartadas: `confirmarSurtido` no lo detectaba (solo bloquea
        // PENDIENTE y faltantes PARCIAL/NO_DISPONIBLE), el pedido avanzaba a
        // pago y el cliente pagaba 5 piezas de las que bodega solo había
        // apartado 2.
        //
        // La regla correcta: las piezas que nadie verificó tienen que volver a
        // bodega. Si la cantidad SUBE, el item pasa a PENDIENTE; si BAJA, lo
        // apartado se ajusta (el sobrante regresa al anaquel) y sigue COMPLETO.
        const subeLaCantidad = cantidad > item.cantidadSurtida;
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cantidad,
            subtotal: new Prisma.Decimal(item.precioUnitario).mul(cantidad),
            ...(subeLaCantidad
              ? {
                  // Hay piezas nuevas que nadie verificó: bodega re-surte.
                  estadoSurtido: 'PENDIENTE',
                  cantidadSurtida: 0,
                }
              : {
                  // Todo lo pedido ya estaba apartado; el sobrante vuelve.
                  estadoSurtido: 'COMPLETO',
                  cantidadSurtida: cantidad,
                }),
          },
        });
        cambios.push(
          `Item #${it.itemId}: ${item.cantidad} → ${cantidad} pzas` +
            (subeLaCantidad ? ' (vuelve a bodega a surtir)' : ''),
        );
      }
    }

    // Guard espejo del de `confirmarSurtido`: un pedido sin items activos no
    // tiene nada que surtir ni cobrar.
    const activos = await tx.itemPedido.count({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    if (activos === 0) {
      throw new BadRequestException(
        'El ajuste dejaría el pedido sin productos. Si el cliente no quiere ' +
          'nada, cancela el pedido en vez de ajustarlo.',
      );
    }

    await recalcularTotalesPedido(tx, pedido);
    return cambios;
  }

  /**
   * Validaciones del ajuste, ANTES de abrir la transacción (fallar rápido y con
   * mensajes claros en vez de reventar a mitad del commit).
   */
  private validarAjuste(
    items: ItemAjusteDto[],
    itemsActuales: Array<{ id: number; cancelada: boolean }>,
  ): void {
    const ids = new Set(itemsActuales.map((i) => i.id));

    for (const it of items) {
      if (it.tipo === 'agregado') {
        if (!it.precioCOId) {
          throw new BadRequestException(
            'Un producto agregado requiere precioCOId.',
          );
        }
        continue;
      }
      if (it.tipo === 'completo') continue;

      if (it.itemId == null) {
        throw new BadRequestException(
          `El tipo "${it.tipo}" requiere itemId.`,
        );
      }
      if (!ids.has(it.itemId)) {
        throw new BadRequestException(
          `El item ${it.itemId} no pertenece a este pedido.`,
        );
      }
      if (it.tipo === 'parcial' && (it.cantidad == null || it.cantidad < 1)) {
        throw new BadRequestException(
          'Un ajuste parcial requiere una cantidad mayor a 0.',
        );
      }
    }
  }

  /**
   * `EN_MOSTRADOR → CANCELLED` + lista de reposición.
   *
   * La reposición se crea DENTRO de la misma transacción (`efectos`): si la
   * cancelación se aplica pero la lista falla, quedaría mercancía apartada sin
   * nadie que la devuelva al anaquel. `crearDesdePedido` es idempotente, así
   * que un segundo intento no duplica.
   *
   * No se encola nada a Firebird: el pedido nunca llegó al ERP (con el flujo
   * nuevo el encolado ocurre al liberar, no al surtir). Si el pedido ya estaba
   * en PENDING_PAID, la cancelación la sincroniza el agente por `SWCANCEL`.
   */
  async cancelar(pedidoId: number, usuario: UserContext, motivo: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'cancelar');

    return this.pedidoState.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.CANCELLED,
        observacion: `Cancelado en mostrador por ${usuario.nombre}: ${motivo}`,
      },
      usuario,
      {
        asignacion: 'limpiar',
        reloj: 'detener',
        invalidarMonitor: true,
        efectos: async (tx) => {
          await this.reposicion.crearDesdePedido(tx, pedidoId, motivo);
        },
      },
    );
  }

  /**
   * F16 (sep 2026): descarta un aviso de llegada falso.
   *
   * El cliente avisó que llegó pero no está (o se fue sin recoger). Sin esta
   * acción, `llegadaDescartadaAt` nunca se escribía — la columna se leía en
   * seis lugares pero no había forma de poblarla — así que el badge
   * "EN TIENDA" quedaba pegado y el operador llamaba a alguien que ya no está.
   *
   * No cambia el estado del pedido: el aviso es una señal de cola, ortogonal
   * al ciclo de vida. El pedido sigue operable (liberar/ajustar/cancelar).
   *
   * Se registra en el historial para poder auditar cuántos avisos resultan
   * falsos — es la señal de que el gate de llegada se está usando mal.
   */
  async descartarLlegada(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        numeroPedido: true,
        tiendaId: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
      },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    if (!completo.llegadaAnunciadaAt || completo.llegadaDescartadaAt) {
      throw new BadRequestException(
        'Este pedido no tiene un aviso de llegada vigente que descartar.',
      );
    }

    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: {
        llegadaDescartadaAt: new Date(),
        llegadaDescartadaPorId: usuario.userId,
      },
    });

    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion: `Aviso de llegada descartado por ${usuario.nombre} (el cliente no estaba)`,
        usuarioId: usuario.userId,
        usuarioNombre: usuario.nombre,
      },
    });

    // La TV y la consola dejan de mostrarlo como "EN TIENDA".
    this.realtime.emitToTienda(completo.tiendaId, 'monitor.invalidado', { pedidoId });

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): aviso de llegada descartado por ${usuario.nombre}`,
    );

    return { ok: true, pedidoId };
  }

  /**
   * Guard compartido de las tres acciones: solo se opera un pedido que está
   * esperando revisión. Si ya fue liberado (PENDING_PAID) o cancelado, la
   * acción no aplica y el mensaje dice cuál es el estado real.
   */
  private exigirEstado(estadoActual: EstadoPedido, accion: string): void {
    if (estadoActual !== EstadoPedido.EN_MOSTRADOR) {
      throw new BadRequestException(
        `Solo se puede ${accion} un pedido en EN_MOSTRADOR (actual: ${estadoActual})`,
      );
    }
  }

  /**
   * F16 (sep 2026): el operador manda a llamar a un cliente.
   *
   * NO cambia el estado del pedido — es una señal de cola, igual que el aviso
   * de llegada. Existe porque el monitor de mostrador ES el canal de aviso del
   * flujo (decisión D16): el cliente ve su folio en la pantalla de la tienda y
   * sabe que le toca pasar a revisar su pedido. No hay email.
   *
   * Emite `pedido.llamado-mostrador` a `tienda-{id}` para que la TV muestre la
   * alerta grande y suene. El payload lleva el folio y el nombre del cliente
   * para que se identifique, más el nombre del operador (para que el cliente
   * sepa a quién buscar).
   *
   * Se registra en el historial para poder auditar cuántas veces se llamó a un
   * mismo pedido (útil si el cliente no aparece).
   */
  async llamar(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'llamar');

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { numeroPedido: true, clienteNombre: true, tiendaId: true },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    // `UserContext` no trae apellido (viene del JWT), así que el nombre del
    // operador es el que ya está disponible.
    const nombreOperador = usuario.nombre;

    // F16: el pedido pasa al panel "Atendiendo" de la TV y se QUEDA ahí hasta
    // que salga de EN_MOSTRADOR (lo limpia `PedidoStateService.cambiarEstado`).
    // Antes la única señal era el evento efímero, así que a los 6s el folio
    // volvía a la cola como si nadie lo hubiera llamado.
    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: { llamadoAt: new Date() },
    });

    // Historial sin cambio de estado: deja constancia de la llamada.
    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion: `Llamado a mostrador por ${nombreOperador}`,
        usuarioId: usuario.userId,
        usuarioNombre: usuario.nombre,
      },
    });

    this.realtime.emitToTienda(completo.tiendaId, 'pedido.llamado-mostrador', {
      id: pedidoId,
      numeroPedido: completo.numeroPedido,
      clienteNombre: completo.clienteNombre,
      operadorId: usuario.userId,
      operadorNombre: nombreOperador,
    });

    // El pedido acaba de pasar de la cola al panel "Atendiendo": la TV tiene
    // que recomputar el snapshot, o el folio seguiría en la lista de espera
    // hasta el siguiente poll (5s) mientras la alerta ya lo está anunciando.
    this.realtime.emitToTienda(completo.tiendaId, 'monitor.invalidado', {
      pedidoId,
    });

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): llamado a mostrador por ${nombreOperador}`,
    );

    return {
      pedidoId,
      numeroPedido: completo.numeroPedido,
      clienteNombre: completo.clienteNombre,
      operadorNombre: nombreOperador,
    };
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
