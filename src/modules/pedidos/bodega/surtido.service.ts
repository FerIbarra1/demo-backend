import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import {
  EstadoPedido,
  EstadoSurtido,
  EstadoPropuesta,
  Prisma,
} from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { MarcarSurtidoItemDto } from './dto/surtido.dto';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { destinoTrasSurtido } from '../core/destino-post-surtido.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { rankearSimilares } from '../core/similitud.util';
import {
  MAX_PEDIDOS_POR_BODEGUERO,
  ESTADOS_OCUPAN_SLOT_BODEGA,
} from '../core/pedido-limits';
import { aplicarCambiosFisicos } from '../core/aplicar-cambios-surtido.util';
import { recalcularTotalesPedido } from '../core/totales.util';

/**
 * Servicio de surtido en bodega.
 *
 * Flujo:
 *   1. El bodeguero toma el pedido (PENDING_REVIEW → REVIEWING) vía /tomar
 *   2. Va a /bodega/surtir/:id y ve los items
 *   3. Marca cada item con cantidadSurtida + estadoSurtido vía
 *      /items/:itemId/surtido (opcionalmente motivo y nuevoPrecioCOId)
 *   4. Cuando todos los items están en estado terminal (COMPLETO, NO_DISPONIBLE
 *      o PARCIAL), confirma el surtido vía /confirmar-surtido
 *   5. Si todo es COMPLETO → el pedido pasa a PENDING_PAID (encola a Firebird).
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
   * Si el pedido está en PENDING_REVIEW o REVIEWING, incluye `pedidosSimilares`:
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
    if (
      pedido.estado === EstadoPedido.PENDING_REVIEW ||
      pedido.estado === EstadoPedido.REVIEWING
    ) {
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
    if (pedidoActual.estado !== EstadoPedido.REVIEWING) {
      throw new BadRequestException(
        `Sólo se puede surtir en estado REVIEWING (actual: ${pedidoActual.estado})`,
      );
    }

    const item = await this.prisma.itemPedido.findUnique({
      where: { id: itemId },
      select: { id: true, pedidoId: true, cantidad: true, cancelada: true },
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
   *   - Todos los items COMPLETO  → PENDING_PAID (encola a Firebird).
   *   - Algún item PARCIAL / NO_DISPONIBLE → requiere una propuesta ACEPTADA
   *     por el cliente que NO haya sido consumida; aplica los cambios y pasa
   *     a PENDING_PAID.
   *   - Al menos un item aún PENDIENTE  → 400 (debe completar todos los items)
   *
   * F13 (sep 2026): la transición se delega a `PedidoStateService.cambiarEstado`
   * con `efectos` para aplicar los cambios de items en la MISMA transacción.
   * Antes este método escribía el estado a mano, lo que duplicaba historial/
   * realtime/notificación y dejaba el camino fuera de la máquina de estados.
   */
  async confirmarSurtido(pedidoId: number, usuario: UserContext, esAdmin: boolean) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { items: true },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (!esAdmin && pedido.asignadoAId !== usuario.userId) {
      throw new BadRequestException('Sólo el bodeguero asignado puede confirmar este surtido');
    }
    if (pedido.estado !== EstadoPedido.REVIEWING) {
      throw new BadRequestException(
        `Sólo se puede confirmar surtido en estado REVIEWING (actual: ${pedido.estado})`,
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
    const incoherentes = pedido.items.filter(
      (i) =>
        !i.cancelada &&
        i.estadoSurtido === EstadoSurtido.COMPLETO &&
        i.cantidadSurtida < i.cantidad,
    );
    if (incoherentes.length > 0) {
      const detalle = incoherentes
        .map((i) => `#${i.id} (${i.cantidadSurtida}/${i.cantidad})`)
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

    // F13: si hay faltantes, exigir una propuesta ACEPTADA y NO CONSUMIDA.
    // Sin el filtro de `consumidaAt`, una propuesta aceptada en una ronda
    // anterior autorizaría faltantes nuevos sin que el cliente los aprobara.
    //
    // NOTA (sep 2026): hoy esta rama es INALCANZABLE — los dos caminos de
    // aprobación (`aprobarPropuestaBodega` y `aprobarPropuestaVentas`) escriben
    // `consumidaAt` en el mismo acto de aprobar, así que nunca existe una
    // ACEPTADA sin consumir. Se conserva como red de seguridad barata: es la
    // que atrapa un faltante GENUINO no aprobado (el caso "bodega encontró
    // menos de lo que el cliente aprobó"), y su mensaje es el correcto ahí.
    let propuestaAceptada: { id: number } | null = null;
    if (itemsConFaltante.length > 0) {
      propuestaAceptada = await this.prisma.pedidoPropuesta.findFirst({
        where: { pedidoId, estado: EstadoPropuesta.ACEPTADA, consumidaAt: null },
        orderBy: { respondidaAt: 'desc' },
        select: { id: true },
      });
      if (!propuestaAceptada) {
        throw new BadRequestException(
          `Hay ${itemsConFaltante.length} item(s) con faltante. ` +
            'Envía la propuesta al cliente (botón "Enviar propuesta") y espera a que la acepte antes de confirmar el surtido.',
        );
      }
    }

    // Los cambios se aplican DENTRO de la transacción de la transición (vía
    // `efectos`), así que la descripción se captura desde el callback.
    let cambios: string[] = [];

    // F16 (sep 2026): a dónde va el pedido depende del modo de entrega.
    //   - DOMICILIO       → PENDING_PAID, encolado inmediato a Firebird.
    //   - KIOSKO / RECOGER→ EN_MOSTRADOR, SIN encolar (entra al ERP cuando
    //                       mostrador lo libere, ya con el cliente conforme).
    // La decisión vive en `destinoTrasSurtido` para que los caminos de
    // propuesta no puedan divergir (riesgo R12 del plan).
    const destino = destinoTrasSurtido(pedido.modoEntrega);
    const vaAMostrador = destino.estado === EstadoPedido.EN_MOSTRADOR;

    const pedidoActualizado = await this.state.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: destino.estado,
        observacion: vaAMostrador
          ? propuestaAceptada
            ? `Surtido confirmado con faltante(s) (propuesta #${propuestaAceptada.id} aceptada) — pasa a mostrador`
            : 'Surtido confirmado completo — pasa a mostrador'
          : propuestaAceptada
            ? `Surtido confirmado con faltante(s) (propuesta #${propuestaAceptada.id} aceptada) — pendiente de pago`
            : 'Surtido confirmado completo — pendiente de pago',
      },
      usuario,
      {
        // La bodega libera el pedido al confirmar: ya no lo carga.
        asignacion: 'limpiar',
        // El reloj se detiene: ya no es tarea de bodega.
        reloj: 'detener',
        // Obligatorio para PENDING_PAID: sin fila de cola el pedido es
        // invisible al agente. Para EN_MOSTRADOR va en false a propósito —
        // el ERP sólo debe ver pedidos que el cliente ya confirmó.
        encolarFirebird: destino.encolarFirebird,
        // Los monitores deben recomputar (slot del bodeguero + cola de
        // cajeros + cola de mostrador).
        invalidarMonitor: true,
        efectos: propuestaAceptada
          ? async (tx) => {
              cambios = await this.aplicarCambiosSurtido(tx, pedido, itemsConFaltante);
              // Marcar la propuesta como consumida para que no autorice
              // faltantes de una ronda futura.
              await tx.pedidoPropuesta.update({
                where: { id: propuestaAceptada!.id },
                data: { consumidaAt: new Date() },
              });
            }
          : undefined,
      },
    );

    this.logger.log(
      `Pedido ${pedidoId}: surtido confirmado (${cambios.length} cambio(s)) → ${destino.estado}`,
    );

    return {
      mensaje: propuestaAceptada
        ? `Surtido confirmado con ${cambios.length} cambio(s) aplicado(s)`
        : 'Surtido completo confirmado',
      estado: destino.estado,
      pedido: pedidoActualizado,
      cambiosAplicados: cambios.length,
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
        estado: EstadoPedido.PENDING_REVIEW,
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
      throw new BadRequestException(
        'Si el estado es PENDIENTE, la cantidad surtida debe ser 0',
      );
    }
    if (dto.estadoSurtido === EstadoSurtido.COMPLETO && dto.cantidadSurtida < 1) {
      throw new BadRequestException(
        'Si el estado es COMPLETO, la cantidad surtida debe ser >= 1',
      );
    }
    if (dto.estadoSurtido === EstadoSurtido.NO_DISPONIBLE && dto.cantidadSurtida !== 0) {
      throw new BadRequestException(
        'Si el estado es NO_DISPONIBLE, la cantidad surtida debe ser exactamente 0',
      );
    }
  }
}
