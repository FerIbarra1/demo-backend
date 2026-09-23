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
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { rankearSimilares } from '../core/similitud.util';
import {
  MAX_PEDIDOS_POR_BODEGUERO,
  ESTADOS_OCUPAN_SLOT_BODEGA,
} from '../core/pedido-limits';

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
      select: { id: true, pedidoId: true, cantidad: true },
    });
    if (!item || item.pedidoId !== pedidoId) {
      throw new NotFoundException(`Item ${itemId} no pertenece al pedido ${pedidoId}`);
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

    // Validar que todos los items estén en estado terminal
    const pendientes = pedido.items.filter((i) => i.estadoSurtido === EstadoSurtido.PENDIENTE);
    if (pendientes.length > 0) {
      throw new BadRequestException(
        `Hay ${pendientes.length} item(s) aún PENDIENTE de surtir. Márcalos antes de confirmar.`,
      );
    }

    // Detectar faltantes: PARCIAL o NO_DISPONIBLE.
    const itemsConFaltante = pedido.items.filter(
      (i) =>
        i.estadoSurtido === EstadoSurtido.PARCIAL ||
        i.estadoSurtido === EstadoSurtido.NO_DISPONIBLE,
    );

    // F4 (jun 2026): no permitir pedidos con 0 productos activos.
    // Simula el resultado tras aplicar los cambios y cuenta cuántos items
    // activos quedarán. Si es 0, rechazar: bodega debe dejar al menos un item
    // con cantidad > 0.
    //
    // Reglas de conteo (espejo de `aplicarCambiosSurtido`):
    //   - NO_DISPONIBLE → cuenta 0 (se cancela).
    //   - PARCIAL con cantidadSurtida > 0 → cuenta 1.
    //   - PARCIAL con cantidadSurtida === 0 → cuenta 0.
    //   - COMPLETO → cuenta 1.
    const itemsActivosFinales = pedido.items.reduce((acc, it) => {
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

    const pedidoActualizado = await this.state.cambiarEstado(
      pedidoId,
      {
        nuevoEstado: EstadoPedido.PENDING_PAID,
        observacion: propuestaAceptada
          ? `Surtido confirmado con faltante(s) (propuesta #${propuestaAceptada.id} aceptada) — pendiente de pago`
          : 'Surtido confirmado completo — pendiente de pago',
      },
      usuario,
      {
        // La bodega libera el pedido al confirmar: ya no espera pago.
        asignacion: 'limpiar',
        // El reloj se detiene: ya no es tarea de bodega.
        reloj: 'detener',
        // Obligatorio: un PENDING_PAID sin fila de cola es invisible al agente.
        encolarFirebird: true,
        // Los monitores deben recomputar (slot del bodeguero + cola de cajeros).
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
      `Pedido ${pedidoId}: surtido confirmado (${cambios.length} cambio(s)) → PENDING_PAID`,
    );

    return {
      mensaje: propuestaAceptada
        ? `Surtido confirmado con ${cambios.length} cambio(s) aplicado(s)`
        : 'Surtido completo confirmado',
      estado: EstadoPedido.PENDING_PAID,
      pedido: pedidoActualizado,
      cambiosAplicados: cambios.length,
    };
  }

  /**
   * Aplica los cambios de bodega (cancelar NO_DISPONIBLES, ajustar PARCIALES,
   * crear sustituciones) sobre los items del pedido. Recalcula subtotal y
   * total. Helper extraído para que `confirmarSurtido` quede legible.
   *
   * F13 (sep 2026): ya NO maneja sustituciones — el bodeguero perdió esa
   * capacidad (es tarea del asesor de ventas, que arma una contrapropuesta
   * completa). Solo cancela NO_DISPONIBLES y ajusta PARCIALES.
   *
   * Devuelve un array con la descripción de cada cambio aplicado (para el log).
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
    const cambios: string[] = [];

    for (const item of itemsConFaltante) {
      // NO_DISPONIBLE: cancelar el item.
      if (item.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) {
        await tx.itemPedido.update({
          where: { id: item.id },
          data: { cancelada: true },
        });
        cambios.push(`Item #${item.id} cancelado (no disponible)`);
        continue;
      }

      // PARCIAL: ajustar cantidad al valor surtido y recalcular subtotal.
      if (item.estadoSurtido === EstadoSurtido.PARCIAL) {
        const nuevaCantidad = Math.max(0, item.cantidadSurtida);
        // F12: si la cantidad surtida es 0, el item se CANCELA (no queda
        // activo con cantidad 0).
        if (nuevaCantidad === 0) {
          await tx.itemPedido.update({
            where: { id: item.id },
            data: { cancelada: true, estadoSurtido: EstadoSurtido.NO_DISPONIBLE },
          });
          cambios.push(`Item #${item.id} cancelado (cantidad 0)`);
          continue;
        }
        const itemActual = await tx.itemPedido.findUnique({ where: { id: item.id } });
        if (!itemActual) throw new NotFoundException(`Item ${item.id} no existe`);
        const nuevoSubtotal = new Prisma.Decimal(itemActual.precioUnitario).mul(nuevaCantidad);
        // F13 (bug fix): reescribir `estadoSurtido` a COMPLETO. Antes se
        // ajustaba la cantidad pero el item quedaba marcado PARCIAL para
        // siempre, así que en la siguiente ronda `itemsConFaltante` lo volvía
        // a levantar y `confirmarSurtido` encontraba la propuesta ACEPTADA de
        // la ronda anterior → pasaba a pago sin aprobación nueva.
        await tx.itemPedido.update({
          where: { id: item.id },
          data: {
            cantidad: nuevaCantidad,
            subtotal: nuevoSubtotal,
            estadoSurtido: EstadoSurtido.COMPLETO,
          },
        });
        cambios.push(`Item #${item.id} ajustado a ${nuevaCantidad} piezas`);
      }
    }

    // Recalcular subtotal del pedido con items no cancelados.
    const itemsActuales = await tx.itemPedido.findMany({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    const nuevoSubtotal = itemsActuales.reduce(
      (acc, i) => acc.plus(new Prisma.Decimal(i.subtotal)),
      new Prisma.Decimal(0),
    );
    // F13 (bug fix): el total respeta descuento e impuestos del pedido. Antes
    // se asignaba `total = subtotal`, borrando cualquier descuento aplicado.
    const nuevoTotal = nuevoSubtotal
      .minus(new Prisma.Decimal(pedido.descuento))
      .plus(new Prisma.Decimal(pedido.impuestos));
    await tx.pedido.update({
      where: { id: pedido.id },
      data: { subtotal: nuevoSubtotal, total: nuevoTotal },
    });

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
