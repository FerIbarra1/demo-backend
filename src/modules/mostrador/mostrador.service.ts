import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, EstadoPedido, RolUsuario, CanalOrigen } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { RealtimeService } from '../realtime/realtime.service';
import { recalcularTotalesPedido } from '../pedidos/core/totales.util';
import { construirItemPedido } from '../pedidos/core/item-pedido.util';
import { PreciosService } from '../precios/precios.service';
import { precioDeLista, ColumnaLista, COLUMNA_MAYOREO } from '../precios/precio-lista.util';
import { ItemAjusteDto } from './dto/accion-mostrador.dto';
import { KioskoLlegadaService } from '../kiosko/kiosko-llegada.service';
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
 *        - `enviarAPagar` → PENDING_PAID (AQUÍ entra al ERP: Firebird solo ve
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
    private readonly llegada: KioskoLlegadaService,
  ) {}

  // ==================================================================
  // F16 (sep 2026): la cola de EN_MOSTRADOR y las tres acciones del operador
  // ==================================================================

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
  async enviarAPagar(pedidoId: number, usuario: UserContext, nota?: string) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'enviar a pagar');

    // Decisión D2 del plan: el operador PUEDE mandar a pagar sin que el cliente haya
    // avisado llegada (sabe más que el sistema). Queda registrado para poder
    // auditar cuántas veces se salta el gate.
    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { llegadaAnunciadaAt: true, llegadaDescartadaAt: true },
    });
    const avisoVigente = Boolean(completo?.llegadaAnunciadaAt && !completo.llegadaDescartadaAt);
    const sufijoAviso = avisoVigente ? '' : ' (sin aviso de llegada del cliente)';
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
  async ajustar(pedidoId: number, usuario: UserContext, nota: string, items?: ItemAjusteDto[]) {
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
              resumenCambios = await this.aplicarAjuste(tx, pedidoCompleto, items!, columnaLista);
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
      (
        await tx.itemPedido.findMany({
          where: { pedidoId: pedido.id },
          select: { id: true },
        })
      ).map((i) => i.id),
    );

    for (const it of items) {
      if (it.tipo === 'completo') continue;

      if (it.tipo === 'agregado') {
        if (!it.precioCOId) {
          throw new BadRequestException('Un producto agregado requiere precioCOId.');
        }
        const pco = await tx.precioCO.findUnique({
          where: { id: it.precioCOId },
          include: { producto: true, talla: true, color: true, corrida: true },
        });
        if (!pco) {
          throw new BadRequestException(`PrecioCO ${it.precioCOId} no existe`);
        }
        if (pco.tiendaId !== pedido.tiendaId) {
          throw new BadRequestException('El producto agregado pertenece a otra tienda.');
        }

        const cantidad = Math.max(1, it.cantidad ?? 1);
        // Promo de volumen: el precio efectivo lo decide el tamaño FINAL del
        // pedido, no el de este item aislado. `construirItemPedido` congela el
        // par y deja el efectivo en la base; `recalcularTotalesPedido` (que
        // corre al final de este método) lo ajusta al mayoreo si el pedido
        // llega a 12.
        //
        // `original: false` — nadie verificó este producto contra el anaquel.
        // Es la señal que bodega usa para saber que el pedido volvió con
        // cambios.
        await tx.itemPedido.create({
          data: {
            ...construirItemPedido(pco, cantidad, {
              columnaLista,
              original: false,
            }),
            pedidoId: pedido.id,
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
          throw new BadRequestException('Un producto agregado requiere precioCOId.');
        }
        continue;
      }
      if (it.tipo === 'completo') continue;

      if (it.itemId == null) {
        throw new BadRequestException(`El tipo "${it.tipo}" requiere itemId.`);
      }
      if (!ids.has(it.itemId)) {
        throw new BadRequestException(`El item ${it.itemId} no pertenece a este pedido.`);
      }
      if (it.tipo === 'parcial' && (it.cantidad == null || it.cantidad < 1)) {
        throw new BadRequestException('Un ajuste parcial requiere una cantidad mayor a 0.');
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
   * nuevo el encolado ocurre al enviar a pagar, no al surtir). Si el pedido ya estaba
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
   * al ciclo de vida. El pedido sigue operable (enviar a pagar / ajustar / cancelar).
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
   * Oct 2026: el operador marca la llegada EN NOMBRE del cliente.
   *
   * El caso que lo motiva: hay clientes que llegan a tienda y van directo al
   * mostrador, sin teléfono a la mano o sin el folio. Con el gate de D5 su
   * pedido web está OCULTO de la cola hasta que alguien avisa, así que sin esta
   * acción el operador no tenía forma de hacerlo aparecer — el pedido quedaba
   * atrapado aunque el cliente estuviera enfrente.
   *
   * Toda la escritura vive en `KioskoLlegadaService.confirmarDesdeMostrador`
   * (idempotencia, límite de tasa, realtime e historial compartidos con los
   * caminos del kiosko y de la app del cliente). Aquí solo se delega, para que
   * la consola tenga su endpoint junto a las demás acciones del mostrador.
   *
   * NO cambia el estado del pedido: la llegada es ortogonal al ciclo de vida.
   */
  async marcarLlegada(pedidoId: number, usuario: UserContext) {
    // Validación de tienda/rol aquí, no en el servicio de llegada: `KioskoModule`
    // no puede importar `PedidosModule` (sería un ciclo, porque `PedidosModule`
    // ya importa `KioskoModule`).
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.llegada.confirmarDesdeMostrador(pedidoId, usuario);
  }

  /**
   * Oct 2026: deshace un "Llamar por la TV".
   *
   * En cajero, tomar un pedido se puede deshacer (`liberarPedidoCajero` lo
   * devuelve a la cola). En mostrador no había vuelta atrás: `llamar` movía el
   * folio al panel "Atendiendo" de la TV y `PedidoStateService` solo limpiaba
   * `llamadoAt` al SALIR de `EN_MOSTRADOR`. Si el operador se equivocaba de
   * folio, el cliente equivocado quedaba anunciado en la pantalla y el correcto
   * ya no estaba en la lista de espera.
   *
   * NO se llama `liberar` a propósito: en mostrador ese nombre ya significa
   * `EN_MOSTRADOR → PENDING_PAID` (el pedido entra al ERP). Devolver a la cola
   * es lo contrario de eso.
   *
   * Tampoco asigna el pedido a una persona: el mostrador es una cola lineal por
   * decisión D16, no un modelo de ventanillas 1:1 como el cajero.
   */
  async devolverACola(pedidoId: number, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);
    this.exigirEstado(pedido.estado, 'devolver a la cola');

    const completo = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { numeroPedido: true, tiendaId: true, llamadoAt: true },
    });
    if (!completo) throw new BadRequestException('Pedido no encontrado');

    if (completo.llamadoAt === null) {
      throw new BadRequestException(
        'Este pedido no está anunciado en la pantalla, así que no hay nada que regresar a la cola.',
      );
    }

    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: { llamadoAt: null },
    });

    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion: `Devuelto a la cola por ${usuario.nombre}`,
        usuarioId: usuario.userId,
        usuarioNombre: usuario.nombre,
      },
    });

    // La TV tiene que recomputar: el folio sale del panel "Atendiendo" y vuelve
    // a la lista de espera. Sin esto seguiría anunciado hasta el siguiente poll.
    this.realtime.emitToTienda(completo.tiendaId, 'monitor.invalidado', {
      pedidoId,
    });

    this.logger.log(
      `Pedido ${pedidoId} (${completo.numeroPedido}): devuelto a la cola por ${usuario.nombre}`,
    );

    return { ok: true, pedidoId };
  }

  /**
   * Manda a llamar al SIGUIENTE de la cola (FIFO), sin que el operador tenga
   * que elegir el pedido. Es el espejo de `CajeroService.llamarSiguiente`.
   *
   * Por qué existe: en cajero el operador puede llamar al siguiente o tomar
   * uno específico; en mostrador sólo estaba lo segundo. Con un cliente
   * enfrente el operador busca su folio, pero cuando la fila está llena y
   * nadie se acerca, llamar al siguiente es el flujo natural — y era el único
   * caso donde el operador tenía que elegir un pedido a mano.
   *
   * Elige el PRIMERO de la cola de revisión: mismo orden que ve la consola
   * (`fechaPedido asc`), así que "el siguiente" es literalmente la primera
   * fila de la pestaña "Por revisar".
   *
   * Reutiliza `llamar` para no duplicar los efectos (llamadoAt, historial,
   * realtime, invalidación del monitor).
   */
  async llamarSiguiente(usuario: UserContext) {
    if (!usuario.tiendaId) {
      throw new BadRequestException('Tu usuario no tiene tienda asignada');
    }

    const siguiente = await this.prisma.pedido.findFirst({
      where: {
        tiendaId: usuario.tiendaId,
        estado: EstadoPedido.EN_MOSTRADOR,
        // Un pedido ya llamado sigue en EN_MOSTRADOR pero ya está anunciado en
        // la TV: volver a llamarlo lo dejaría pegado en el panel.
        llamadoAt: null,
      },
      orderBy: { fechaPedido: 'asc' },
      select: { id: true },
    });
    if (!siguiente) {
      throw new NotFoundException('No hay pedidos en la cola por revisar');
    }

    return this.llamar(siguiente.id, usuario);
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
    if (pedido.estado !== EstadoPedido.PAID && pedido.estado !== EstadoPedido.SHIPPED) {
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
