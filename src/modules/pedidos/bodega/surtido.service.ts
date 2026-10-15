import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { EstadoPedido, EstadoSurtido, EstadoPropuesta, Prisma } from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { MarcarSurtidoItemDto } from './dto/surtido.dto';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import {
  destinoTrasSurtido,
  destinoTrasSurtidoIncompleto,
  clientePresenteEnTienda,
} from '../core/destino-post-surtido.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { rankearSimilares } from '../core/similitud.util';
import { MAX_PEDIDOS_POR_BODEGUERO, ESTADOS_OCUPAN_SLOT_BODEGA } from '../core/pedido-limits';
import { aplicarCambiosFisicos } from '../core/aplicar-cambios-surtido.util';
import {
  piezasEnLaBolsa,
  piezasFueraDeLaBolsa,
  piezasPendientesDeRetiro,
} from '../core/ajuste-cantidad.util';
import { recalcularTotalesPedido } from '../core/totales.util';
import { construirPropuestaDeBodega } from '../core/propuesta-bodega.util';

/**
 * Servicio de surtido en bodega.
 *
 * Flujo:
 *   1. El bodeguero toma el pedido (SOLICITADO → EN_REVISION) vía /tomar
 *   2. Va a /bodega/surtir/:id y ve los items
 *   3. Marca cada item con cantidadSurtida + estadoSurtido vía
 *      /items/:itemId/surtido (opcionalmente motivo y nuevoPrecioCOId)
 *   4. Cuando todos los items están en estado terminal (COMPLETO, NO_DISPONIBLE
 *      o PARCIAL), confirma el surtido vía /confirmar-surtido
 *   5. Si todo es COMPLETO → el pedido pasa a PENDIENTE_PAGO (encola a Firebird).
 *      Si hay faltantes → el bodeguero envía una propuesta (PropuestaService) y
 *      solo cuando el cliente la acepta puede confirmar el surtido.
 */

@Injectable()
export class SurtidoService {
  private readonly logger = new Logger(SurtidoService.name);

  constructor(
    private prisma: PrismaService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Devuelve el detalle del pedido con todos los items y su estado de surtido.
   * Cualquier bodeguero de la tienda puede VERLO (read-only); sólo el asignado
   * (o un admin) puede MODIFICAR items.
   *
   * Si el pedido está en SOLICITADO o EN_REVISION, incluye `pedidosSimilares`:
   * lista de pedidos en cola de la misma tienda con items compartidos, para
   * alimentar el banner "surtir juntos" del frontend.
   */
  async obtenerDetalle(pedidoId: number, usuario: UserContext, esAdmin: boolean) {
    // Cualquier bodeguero de la tienda puede VER; no exigimos asignación aquí.
    // Eso permite abrir el detalle desde la lista de pendientes antes de tomarlo.
    const pedidoReducido = await this.access.cargarYValidar(pedidoId, usuario);

    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: {
          orderBy: { id: 'asc' },
          include: {
            producto: {
              select: {
                imagenPrincipal: true,
                imagenesProducto: { select: { url: true, colorId: true } },
              },
            },
            precioCO: { select: { colorId: true } },
            sustitucionPropuesta: {
              include: {
                producto: {
                  select: {
                    id: true,
                    nombre: true,
                    codigo: true,
                    imagenPrincipal: true,
                    imagenesProducto: { select: { url: true, colorId: true } },
                  },
                },
                talla: { select: { nombre: true } },
                color: { select: { nombre: true, hex: true } },
                corrida: { select: { nombre: true } },
              },
            },
          },
        },
        tienda: { select: { id: true, nombre: true } },
        usuario: { select: { id: true, nombre: true, email: true, telefono: true } },
        asignadoA: { select: { id: true, nombre: true, apellido: true } },
        // F12: propuestas de ajuste (historial de negociación bodega↔cliente).
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
            forzadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    // Coherencia con el access check (defensa en profundidad).
    if (!esAdmin && usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido pertenece a otra tienda');
    }
    // Sanity check: el access service ya validó tienda/asignación, pero si no es
    // admin y el pedido no está asignado a nadie, sólo el asignado puede mutar —
    // aquí no mutamos, así que permitimos.
    void pedidoReducido;

    // Adjuntar productoImagen a cada item: la imagen del color de la variante
    // (si el producto tiene imágenes asociadas a ese color); fallback a la
    // imagen principal. Para que el chat con cards embebidas muestre la foto.
    pedido.items = pedido.items.map((it: any) => {
      const imagenColor = it.producto?.imagenesProducto?.find(
        (img: any) => img.colorId === it.precioCO?.colorId,
      )?.url;
      return {
        ...it,
        productoImagen: this.storage.resolverImagen(
          imagenColor ?? it.producto?.imagenPrincipal ?? null,
        ),
      };
    }) as any;

    // Banner "surtir juntos": sólo si el pedido está en estados accionables.
    let pedidosSimilares: Array<{
      id: number;
      numeroPedido: string;
      score: number;
      itemsCompartidos: number;
      minutosEnCola: number;
    }> = [];
    if (pedido.estado === EstadoPedido.SOLICITADO || pedido.estado === EstadoPedido.EN_REVISION) {
      pedidosSimilares = await this.calcularSimilaresParaPedido(pedido);
    }

    return { ...pedido, pedidosSimilares };
  }

  /**
   * Marca un item con su cantidad surtida y estado. El bodeguero debe ser el
   * asignado, o un admin.
   *
   * F13 (sep 2026): el bodeguero ya NO puede proponer sustituciones. Se
   * eliminó `nuevoPrecioCOId` — las opciones son hay todo / hay menos / no hay.
   * Proponer productos, variantes o cantidades distintas es tarea del asesor
   * de ventas (`VentasService`), que arma una contrapropuesta al cliente.
   */
  async marcarItem(
    pedidoId: number,
    itemId: number,
    dto: MarcarSurtidoItemDto,
    usuario: UserContext,
  ) {
    // Validar coherencia estado/cantidad
    this.validarCoherencia(dto);

    // access + asignación (admin pasa automáticamente)
    await this.access.cargarYValidar(pedidoId, usuario, {
      requiereAsignacionBodega: true,
    });

    const pedidoActual = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true, estado: true, tiendaId: true },
    });
    if (!pedidoActual) throw new NotFoundException('Pedido no encontrado');
    if (pedidoActual.estado !== EstadoPedido.EN_REVISION) {
      throw new BadRequestException(
        `Sólo se puede surtir en estado EN_REVISION (actual: ${pedidoActual.estado})`,
      );
    }

    const item = await this.prisma.itemPedido.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        pedidoId: true,
        cantidad: true,
        cantidadSurtida: true,
        cancelada: true,
      },
    });
    if (!item || item.pedidoId !== pedidoId) {
      throw new NotFoundException(`Item ${itemId} no pertenece al pedido ${pedidoId}`);
    }

    // F16: un item cancelado no se puede "resucitar" vía `marcarItem`. Si el
    // operador necesita recuperarlo, abre una nueva propuesta (que pasa por
    // sus propios guards). Esto cierra el riesgo de revertir cancelaciones
    // que el cliente o el ERP ya dieron por perdidas.
    if (item.cancelada) {
      throw new BadRequestException(
        'No puedes modificar un item cancelado. Si necesitas recuperarlo, abre una nueva propuesta.',
      );
    }

    // F16: la cantidad surtida no puede exceder la cantidad pedida. La UI
    // clampa a `item.cantidad`, pero la API es frontera de confianza — un
    // cliente a mano puede mandar `cantidadSurtida: 999` sobre `cantidad: 5`
    // y persistir basura.
    if (dto.cantidadSurtida > item.cantidad) {
      throw new BadRequestException(
        `La cantidad surtida (${dto.cantidadSurtida}) no puede exceder la cantidad pedida (${item.cantidad}).`,
      );
    }

    /**
     * F21 (oct 2026): con sobrante en la bolsa, `cantidadSurtida` no se puede
     * tocar.
     *
     * `cantidadSurtida` es el hallazgo físico ("lo que hay"); un ajuste a la baja
     * ya no lo pisa, a propósito, para que el sobrante quede a la vista y el
     * bodeguero lo saque de la bolsa. Pero el guard de arriba NO alcanza a
     * protegerlo: con sobrante se cumple `cantidad < cantidadSurtida`, y el
     * valor `dto = cantidad` pasa el guard (no lo excede) **y** reduce el
     * hallazgo. Es exactamente lo que manda la fila del sheet: se pinta con
     * `cantidadSurtida` (3) y clampa el input a `cantidad` (1), así que tocarla
     * —"Hay todo" o teclear— persiste `cantidadSurtida: 1`. El sobrante
     * desaparece del dato y la mercancía de más viaja al área de entrega dentro
     * de la bolsa, que es justo lo que la tarjeta existe para evitar.
     *
     * Por eso el guard mira el sobrante y no solo el tope: si hay piezas de más,
     * la única salida válida es el checklist de retiro.
     */
    if (piezasFueraDeLaBolsa(item) > 0 && dto.cantidadSurtida < item.cantidadSurtida) {
      throw new BadRequestException(
        `Esta línea tiene ${piezasFueraDeLaBolsa(item)} pieza(s) de más en la bolsa. ` +
          'Sácalas con el checklist de retiro: la cantidad surtida es lo que bodega ' +
          'encontró en el anaquel y no se puede reducir.',
      );
    }

    const actualizado = await this.prisma.itemPedido.update({
      where: { id: itemId },
      data: {
        cantidadSurtida: dto.cantidadSurtida,
        estadoSurtido: dto.estadoSurtido,
        surtidoAt: new Date(),
        motivoSurtido: dto.motivo ?? null,
      },
    });

    // Realtime: cualquier otra tablet abierta en el mismo pedido (caso raro,
    // admin reasignando) ve el cambio al instante. La tablet que opera no
    // necesita: su propio state local lo refleja.
    this.realtime.emitToPedido(pedidoId, 'surtido.actualizado', {
      pedidoId,
      itemId,
      estadoSurtido: dto.estadoSurtido,
      cantidadSurtida: dto.cantidadSurtida,
    });

    return actualizado;
  }

  /**
   * Confirma el surtido. Aplica transición de estado coherente:
   *   - Todos los items COMPLETO  → PENDIENTE_PAGO (encola a Firebird).
   *   - Algún item PARCIAL / NO_DISPONIBLE → requiere una propuesta ACEPTADA
   *     por el cliente que NO haya sido consumida; aplica los cambios y pasa
   *     a PENDIENTE_PAGO.
   *   - Al menos un item aún PENDIENTE  → 400 (debe completar todos los items)
   *
   * F13 (sep 2026): la transición se delega a `PedidoStateService.cambiarEstado`
   * con `efectos` para aplicar los cambios de items en la MISMA transacción.
   * Antes este método escribía el estado a mano, lo que duplicaba historial/
   * realtime/notificación y dejaba el camino fuera de la máquina de estados.
   */
  async confirmarSurtido(
    pedidoId: number,
    usuario: UserContext,
    esAdmin: boolean,
    /**
     * F21 (oct 2026): IDs de los items cuya mercancía el bodeguero YA sacó de la
     * bolsa del área de entrega (el checklist de retiro del sheet).
     *
     * Opcional con default `[]` para no romper a los callers que no tienen
     * checklist: el lote (`BodegaLoteSheet`) confirma sin uno porque los pedidos
     * con ajuste están excluidos de `obtenerLoteSurtirJuntos`, y los tests
     * existentes llaman con tres argumentos.
     */
    itemsRetirados: number[] = [],
  ) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: {
        items: {
          // F19 (oct 2026): se trae `producto` para poder resolver la imagen de
          // la propuesta. Antes el include era `items: true` y la propuesta de
          // bodega salía SIN fotos (sólo el placeholder de iniciales), mientras
          // la de ventas sí las traía porque el frontend se las metía al armar
          // su borrador. Mismo criterio de imagen que `obtenerDetalle`.
          include: {
            producto: {
              select: {
                imagenPrincipal: true,
                imagenesProducto: { select: { url: true, colorId: true } },
              },
            },
            precioCO: { select: { colorId: true } },
          },
        },
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (!esAdmin && pedido.asignadoAId !== usuario.userId) {
      throw new BadRequestException('Sólo el bodeguero asignado puede confirmar este surtido');
    }
    if (pedido.estado !== EstadoPedido.EN_REVISION) {
      throw new BadRequestException(
        `Sólo se puede confirmar surtido en estado EN_REVISION (actual: ${pedido.estado})`,
      );
    }

    // Validar que todos los items estén en estado terminal.
    //
    // `!i.cancelada`: un item cancelado conserva su `estadoSurtido` viejo, así
    // que sin este filtro un pedido ya cerrado bloquea la confirmación para
    // siempre.
    const pendientes = pedido.items.filter(
      (i) => !i.cancelada && i.estadoSurtido === EstadoSurtido.PENDIENTE,
    );
    if (pendientes.length > 0) {
      throw new BadRequestException(
        `Hay ${pendientes.length} item(s) aún PENDIENTE de surtir. Márcalos antes de confirmar.`,
      );
    }

    // F16 (sep 2026): red de seguridad del invariante "lo que se cobra es lo
    // que se surtió".
    //
    // Un item COMPLETO significa "bodega verificó y apartó todas las piezas".
    // Si su `cantidadSurtida` quedó por debajo de `cantidad`, alguien subió la
    // cantidad sin volver a surtir (el bug que tenía el ajuste de mostrador) y
    // el pedido avanzaría a pago cobrando piezas que nadie apartó.
    //
    // Esta validación es la que atrapa CUALQUIER camino futuro que deje el item
    // incoherente, no solo el que conocemos hoy.
    //
    // Lo que cuenta es lo que HAY en la bolsa (`piezasEnLaBolsa`), no lo que se
    // encontró alguna vez: las piezas que un ajuste anterior ya sacó están en el
    // anaquel y no cubren lo que se cobra.
    const incoherentes = pedido.items.filter(
      (i) =>
        !i.cancelada &&
        i.estadoSurtido === EstadoSurtido.COMPLETO &&
        piezasEnLaBolsa(i) < i.cantidad,
    );
    if (incoherentes.length > 0) {
      const detalle = incoherentes
        .map((i) => `#${i.id} (${piezasEnLaBolsa(i)}/${i.cantidad})`)
        .join(', ');
      throw new BadRequestException(
        `Hay ${incoherentes.length} item(s) marcados como COMPLETO con menos ` +
          `piezas apartadas que las pedidas: ${detalle}. ` +
          'Vuelve a marcarlos según lo que hay físicamente antes de confirmar.',
      );
    }

    // Detectar faltantes: PARCIAL o NO_DISPONIBLE.
    //
    // `!i.cancelada` es la corrección del bug del "faltante fantasma": al
    // aplicar un `cambio` de la propuesta de ventas, el item original se
    // cancela pero conserva su `estadoSurtido` (PARCIAL/NO_DISPONIBLE). Sin
    // este filtro ese item ya liquidado entraba aquí, exigía una propuesta
    // ACEPTADA sin consumir, y como toda aprobación marca `consumidaAt` en el
    // mismo acto, el bodeguero recibía un 400 sin nada que corregir.
    //
    // Espejo del guard de `aprobarPropuestaBodega` (propuesta.service.ts) y del
    // check de incoherencia de más arriba en este archivo.
    const itemsConFaltante = pedido.items.filter(
      (i) =>
        !i.cancelada &&
        (i.estadoSurtido === EstadoSurtido.PARCIAL ||
          i.estadoSurtido === EstadoSurtido.NO_DISPONIBLE),
    );

    // F4 (jun 2026): no permitir pedidos con 0 productos activos.
    // Simula el resultado tras aplicar los cambios y cuenta cuántos items
    // activos quedarán. Si es 0, rechazar: bodega debe dejar al menos un item
    // con cantidad > 0.
    //
    // Reglas de conteo (espejo de `aplicarCambiosSurtido`):
    //   - cancelada → cuenta 0 (ya no existe).
    //   - NO_DISPONIBLE → cuenta 0 (se cancela).
    //   - PARCIAL con cantidadSurtida > 0 → cuenta 1.
    //   - PARCIAL con cantidadSurtida === 0 → cuenta 0.
    //   - COMPLETO → cuenta 1.
    const itemsActivosFinales = pedido.items.reduce((acc, it) => {
      if (it.cancelada) return acc;
      if (it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) return acc;
      if (it.estadoSurtido === EstadoSurtido.PARCIAL) {
        return acc + (it.cantidadSurtida > 0 ? 1 : 0);
      }
      return acc + 1;
    }, 0);
    if (itemsActivosFinales === 0) {
      throw new BadRequestException(
        'No puedes confirmar el surtido: todos los productos quedarían cancelados o en 0 piezas. ' +
          'Ajusta la cantidad de algún item a >0 antes de confirmar.',
      );
    }

    // F17 (oct 2026): EL CIERRE ES UN SOLO PASO.
    //
    // Antes, si había faltantes, este método lanzaba un 400 pidiendo "envía la
    // propuesta y espera a que el cliente la acepte". Eso contradecía la
    // realidad del piso: el bodeguero YA metió la bolsa con el ticket en la
    // mesa de mostrador. El sistema lo obligaba a dejar el pedido abierto en su
    // cola mientras la mercancía ya estaba físicamente entregada a mostrador.
    //
    // Ahora el bodeguero marca los items y aprieta "Terminar surtido". El
    // sistema aplica los cambios físicos, crea la propuesta si hace falta, y
    // manda el pedido a donde corresponda.
    //
    // F18 (oct 2026): A DÓNDE VA depende de si el cliente está presente.
    //
    //   completo                → REVISADO (área de entrega). Nadie aprueba.
    //   incompleto + PRESENTE   → REVISADO. Mostrador lo resuelve enfrente.
    //   incompleto + AUSENTE    → ESPERANDO_APROBACION. El cliente decide.
    //
    // El bug que esto arregla: F17 mandaba TODO a REVISADO, incluso el
    // incompleto de un cliente ausente. Pero `resolverPropuesta` exige
    // `ESPERANDO_APROBACION`, así que la propuesta nacía **irrespondible** —
    // ni el cliente, ni el operador, ni el admin podían decidirla, y el cliente
    // nunca se enteraba de que su pedido estaba incompleto.
    //
    // `clientePresenteEnTienda` reusa el gate de llegada que ya usa la cola de
    // mostrador: KIOSKO siempre, WEB solo con aviso vigente.
    const hayFaltantes = itemsConFaltante.length > 0;
    const clientePresente = clientePresenteEnTienda(pedido);

    const destino = hayFaltantes
      ? destinoTrasSurtidoIncompleto(pedido.modoEntrega, clientePresente)
      : destinoTrasSurtido(pedido.modoEntrega);

    const vaAMostrador = destino.estado === EstadoPedido.REVISADO;
    const vaAEsperarAprobacion = destino.estado === EstadoPedido.ESPERANDO_APROBACION;
    // La propuesta se crea cuando el pedido va a esperar al cliente, o cuando
    // va al área de entrega con faltantes (para que mostrador tenga el detalle
    // de qué faltó y el cliente lo vea en su app).
    const propuestaAutomatica = hayFaltantes && (vaAMostrador || vaAEsperarAprobacion);

    // Los cambios se aplican DENTRO de la transacción de la transición (vía
    // `efectos`), así que la descripción se captura desde el callback.
    let cambios: string[] = [];
    let propuestaId: number | null = null;

    /**
     * F21 (oct 2026): cuántas piezas se retiraron de la bolsa, por item.
     *
     * Se calcula AQUÍ, antes de la transacción, y no dentro de los `efectos`.
     * Razón: el paso 1 de los efectos (`aplicarCambiosSurtido`) corre primero y,
     * vía `aplicarCambiosFisicos`, escribe `datosDeFaltaDeBodega()` sobre los
     * NO_DISPONIBLE y los PARCIAL con 0 piezas — o sea `cantidadSurtida: 0`. Si
     * se calculara adentro, el incremento saldría 0 justo en el caso más común:
     * una línea cancelada por falta de bodega que SÍ tenía piezas apartadas.
     *
     * El incremento es el PENDIENTE (`piezasPendientesDeRetiro`), NO el total de
     * `piezasFueraDeLaBolsa`. Es la diferencia entre un contador correcto y uno
     * que se pasa:
     *
     *   ronda 1: el ajuste baja de 5 a 3 → fuera 2, pendiente 2 → retiradas 2
     *   ronda 2: el ajuste baja de 3 a 1 → fuera 4, pendiente 2 → retiradas 4
     *
     * Con el TOTAL, la ronda 2 sumaría 4 sobre las 2 ya retiradas y dejaría el
     * contador en 6 sobre un sobrante real de 4. El daño aparece en la ronda 3:
     * al cancelar la línea, `piezasPendientesDeRetiro` clampea a 0 y la ÚLTIMA
     * prenda —la que sigue físicamente en la bolsa— nunca se pide sacar. Es
     * exactamente el fallo que esta columna existe para prevenir.
     *
     * El checklist del sheet es todo-o-nada, así que si el bodeguero pudo
     * confirmar es porque retiró todo lo pendiente: el incremento es el
     * pendiente completo, no lo que marcó.
     */
    const piezasRetiradasPorItem = new Map<number, number>();
    if (itemsRetirados.length > 0) {
      const ids = new Set(itemsRetirados);
      for (const item of pedido.items) {
        if (!ids.has(item.id)) continue;
        const piezas = piezasPendientesDeRetiro(item);
        if (piezas > 0) piezasRetiradasPorItem.set(item.id, piezas);
      }
    }

    const pedidoActualizado = await this.state.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: destino.estado,
        observacion: hayFaltantes
          ? `Surtido confirmado con faltante(s) — ${
              vaAEsperarAprobacion
                ? 'esperando que el cliente apruebe'
                : vaAMostrador
                  ? 'el cliente está en tienda, pasa al área de entrega'
                  : 'pendiente de pago'
            }`
          : `Surtido confirmado completo — ${vaAMostrador ? 'pasa al área de entrega' : 'pendiente de pago'}`,
      },
      usuario,
      {
        // La bodega libera el pedido al confirmar: ya no lo carga.
        asignacion: 'limpiar',
        // El reloj se detiene: ya no es tarea de bodega.
        reloj: 'detener',
        // Obligatorio para PENDIENTE_PAGO: sin fila de cola el pedido es
        // invisible al agente. Para REVISADO va en false a propósito —
        // el ERP sólo debe ver pedidos que el cliente ya confirmó.
        encolarFirebird: destino.encolarFirebird,
        // Los monitores deben recomputar (slot del bodeguero + cola de
        // cajeros + cola de mostrador).
        invalidarMonitor: true,
        efectos: async (tx) => {
          /**
           * F21 (oct 2026): registrar que la mercancía YA salió de la bolsa.
           *
           * Va ANTES de `aplicarCambiosSurtido` por claridad (los valores ya
           * vienen precalculados de afuera, así que el orden no afecta el
           * resultado), pero el motivo de que exista es el de arriba: sin esto,
           * `piezasFueraDeLaBolsa` —que es posicional— vuelve a reportar las
           * mismas prendas en el siguiente ajuste y el bodeguero va a buscar
           * mercancía que ya sacó.
           */
          for (const [itemId, piezas] of piezasRetiradasPorItem) {
            await tx.itemPedido.update({
              where: { id: itemId },
              data: { piezasRetiradas: { increment: piezas } },
            });
          }

          // 1. Liquidar el surtido físico: cancelar los NO_DISPONIBLE y ajustar
          //    los PARCIAL a lo que realmente hay.
          if (hayFaltantes) {
            cambios = await this.aplicarCambiosSurtido(tx, pedido, itemsConFaltante);
          }

          // 2. Crear la propuesta para el cliente cuando el pedido quedó
          //    incompleto. Se crea DENTRO de la transición para que no pueda
          //    existir un pedido incompleto sin propuesta (el cliente no tendría
          //    cómo decidir y el pedido quedaría atorado).
          //
          // Oct 2026: la propuesta YA NO viaja como mensaje de chat con adjunto.
          // Vive en su propia sección del detalle del pedido, que la lee de
          // `Pedido.propuestas` (el backend ya la incluía ahí). El mensaje de
          // sistema que había aquí era un transporte: existía solo porque el
          // frontend sabía pintar propuestas dentro de una burbuja. Además
          // hacía aparecer el chat —que ahora es del asesor de ventas— en un
          // pedido donde todavía no hay nadie del otro lado.
          if (propuestaAutomatica) {
            const { items: itemsPropuesta, total } = construirPropuestaDeBodega(
              pedido.items.map((i) => {
                // F19: la imagen del color de la variante, con fallback a la
                // principal — el mismo criterio que `obtenerDetalle`. Se resuelve
                // AQUÍ y no en el util porque `construirPropuestaDeBodega` es
                // dominio puro (no toca storage).
                const imagenColor = (i as any).producto?.imagenesProducto?.find(
                  (img: any) => img.colorId === (i as any).precioCO?.colorId,
                )?.url;
                return {
                  ...i,
                  productoId: i.productoId,
                  productoImagen: this.storage.resolverImagen(
                    imagenColor ?? (i as any).producto?.imagenPrincipal ?? null,
                  ),
                  precioUnitario: i.precioUnitario,
                  subtotal: i.subtotal,
                };
              }),
            );
            // El índice único parcial `pedidos_propuestas_pendiente_unica_idx`
            // permite UNA sola propuesta PENDIENTE por pedido. Si llega a haber
            // otra viva (p. ej. el operador ajustó el pedido sin resolverla),
            // el create revienta con P2002. Se traduce a un 409 con un mensaje
            // que dice qué hacer, en vez de dejar salir el error crudo de
            // Prisma — que el bodeguero leería como una falla del sistema.
            // Mismo patrón que `messages.service.ts` y `cliente.service.ts`:
            // comprobar `err.code` antes de asumir P2002.
            let propuesta: { id: number };
            try {
              propuesta = await tx.pedidoPropuesta.create({
                data: {
                  pedidoId,
                  estado: EstadoPropuesta.PENDIENTE,
                  items: itemsPropuesta as unknown as Prisma.InputJsonValue,
                  total: new Prisma.Decimal(total),
                  nota: null,
                  creadaPorId: usuario.userId,
                  creadaPorRol: usuario.rol,
                },
                select: { id: true },
              });
            } catch (err) {
              if ((err as { code?: string }).code !== 'P2002') throw err;
              this.logger.error(
                `Pedido ${pedidoId}: ya tenía una propuesta PENDIENTE al cerrar el surtido — ` +
                  `el pedido quedó incompleto sin propuesta nueva`,
              );
              throw new ConflictException(
                'Este pedido ya tiene una propuesta esperando respuesta del cliente. ' +
                  'Resuélvela (o descártala) antes de cerrar un surtido con faltantes.',
              );
            }
            propuestaId = propuesta.id;
          }
        },
      },
    );

    // El aviso al cliente va DESPUÉS del commit (mismo principio que los
    // efectos externos de la máquina de estados): emitir dentro de la
    // transacción anunciaría una propuesta que un rollback podría deshacer.
    if (propuestaId !== null) {
      this.realtime.emitToUser(pedido.usuarioId, 'propuesta.enviada', {
        pedidoId,
        propuestaId,
        origen: usuario.rol,
      });
    }

    this.logger.log(
      `Pedido ${pedidoId}: surtido confirmado (${cambios.length} cambio(s)) → ${destino.estado}` +
        (propuestaId ? ` · propuesta #${propuestaId} enviada al cliente` : ''),
    );

    return {
      mensaje: propuestaId
        ? `Surtido cerrado con ${cambios.length} ajuste(s). Se envió la propuesta al cliente.`
        : 'Surtido completo confirmado',
      estado: destino.estado,
      pedido: pedidoActualizado,
      cambiosAplicados: cambios.length,
      // F17: la UI lo usa para decirle al bodeguero que el pedido quedó
      // incompleto y que el cliente debe decidir.
      propuestaId,
      incompleto: hayFaltantes,
    };
  }

  /**
   * Aplica los cambios de bodega (cancelar NO_DISPONIBLES, ajustar PARCIALES)
   * sobre los items del pedido y recalcula subtotal y total.
   *
   * F16: delega en `aplicarCambiosFisicos` (helper compartido) y en
   * `recalcularTotalesPedido`. Antes era una copia divergente de
   * `PropuestaService.aplicarCambiosDeBodega` — los bugs A–D aparecieron
   * porque divergieron. El helper las unifica.
   */
  async aplicarCambiosSurtido(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
    itemsConFaltante: Array<{
      id: number;
      cantidad: number;
      cantidadSurtida: number;
      estadoSurtido: EstadoSurtido;
      motivoSurtido: string | null;
    }>,
  ): Promise<string[]> {
    const cambios = await aplicarCambiosFisicos(tx, pedido, itemsConFaltante);
    await recalcularTotalesPedido(tx, pedido);
    return cambios;
  }

  /**
   * Verifica que un bodeguero no tenga más de MAX_PEDIDOS_POR_BODEGUERO pedidos
   * asignados. Devuelve true si puede tomar otro, false si está al límite.
   */
  async puedeTomarOtro(usuarioId: number): Promise<boolean> {
    const count = await this.prisma.pedido.count({
      where: {
        asignadoAId: usuarioId,
        estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA },
      },
    });
    return count < MAX_PEDIDOS_POR_BODEGUERO;
  }

  get maxPedidosPorBodeguero(): number {
    return MAX_PEDIDOS_POR_BODEGUERO;
  }

  // ---- helpers ----
  private async calcularSimilaresParaPedido(pedido: {
    id: number;
    tiendaId: number;
    fechaPedido: Date;
  }): Promise<
    Array<{
      id: number;
      numeroPedido: string;
      score: number;
      itemsCompartidos: number;
      minutosEnCola: number;
    }>
  > {
    // Items del pedido actual (productoId + colorId de la zona)
    const itemsActuales = await this.prisma.itemPedido.findMany({
      where: { pedidoId: pedido.id, cancelada: false },
      select: {
        productoId: true,
        precioCO: { select: { colorId: true } },
      },
    });
    if (itemsActuales.length === 0) return [];

    // Pedidos en cola de la misma tienda, distintos al actual
    const candidatos = await this.prisma.pedido.findMany({
      where: {
        tiendaId: pedido.tiendaId,
        estado: EstadoPedido.SOLICITADO,
        id: { not: pedido.id },
      },
      select: {
        id: true,
        numeroPedido: true,
        fechaPedido: true,
        items: {
          where: { cancelada: false },
          select: {
            productoId: true,
            precioCO: { select: { colorId: true } },
          },
        },
      },
    });
    if (candidatos.length === 0) return [];

    return rankearSimilares(
      itemsActuales.map((it) => ({
        productoId: it.productoId,
        colorId: it.precioCO?.colorId ?? null,
      })),
      candidatos.map((c) => ({
        id: c.id,
        numeroPedido: c.numeroPedido,
        fechaPedido: c.fechaPedido,
        items: c.items.map((it) => ({
          productoId: it.productoId,
          colorId: it.precioCO?.colorId ?? null,
        })),
      })),
      { top: 3 },
    );
  }

  private validarCoherencia(dto: MarcarSurtidoItemDto) {
    if (dto.estadoSurtido === EstadoSurtido.PENDIENTE && dto.cantidadSurtida > 0) {
      throw new BadRequestException('Si el estado es PENDIENTE, la cantidad surtida debe ser 0');
    }
    if (dto.estadoSurtido === EstadoSurtido.COMPLETO && dto.cantidadSurtida < 1) {
      throw new BadRequestException('Si el estado es COMPLETO, la cantidad surtida debe ser >= 1');
    }
    if (dto.estadoSurtido === EstadoSurtido.NO_DISPONIBLE && dto.cantidadSurtida !== 0) {
      throw new BadRequestException(
        'Si el estado es NO_DISPONIBLE, la cantidad surtida debe ser exactamente 0',
      );
    }
  }
}
