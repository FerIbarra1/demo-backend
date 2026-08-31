import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EstadoPedido, EstadoSurtido, EstadoRevision, Prisma, TipoNotificacion } from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { MarcarSurtidoItemDto } from './dto/surtido.dto';
import { PedidoAccessService } from '../core/pedido-access.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { rankearSimilares } from '../core/similitud.util';
import { MAX_PEDIDOS_POR_BODEGUERO } from '../core/pedido-limits';

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
 *   5. Si todo es COMPLETO → el pedido pasa a APPROVED
 *      Si hay items con faltante o sustitución propuesta → se genera revisión al
 *      cliente automáticamente y se notifica vía NotificationsService
 */

@Injectable()
export class SurtidoService {
  private readonly logger = new Logger(SurtidoService.name);

  constructor(
    private prisma: PrismaService,
    private access: PedidoAccessService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
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
            producto: { select: { imagenPrincipal: true } },
            sustitucionPropuesta: {
              include: {
                producto: { select: { id: true, nombre: true, codigo: true, imagenPrincipal: true } },
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
        revisiones: {
          where: { estadoRevision: EstadoRevision.PENDIENTE },
          include: { items: true },
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

    // Adjuntar productoImagen (imagen del producto original) a cada item para
    // que el chat con cards embebidas pueda mostrar la foto.
    pedido.items = pedido.items.map((it: any) => ({
      ...it,
      productoImagen: it.producto?.imagenPrincipal ?? null,
    })) as any;

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
   * asignado, o un admin. Si viene nuevoPrecioCOId, se persiste y se valida
   * que pertenezca a la tienda del pedido.
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

    // Validar PrecioCO sustituto: pertenece a la misma tienda
    if (dto.nuevoPrecioCOId) {
      const pco = await this.prisma.precioCO.findUnique({
        where: { id: dto.nuevoPrecioCOId },
        select: { tiendaId: true },
      });
      if (!pco) {
        throw new NotFoundException(`PrecioCO ${dto.nuevoPrecioCOId} no existe`);
      }
      if (pco.tiendaId !== pedidoActual.tiendaId) {
        throw new BadRequestException(
          `El PrecioCO ${dto.nuevoPrecioCOId} pertenece a otra tienda y no puede sustituir un item de este pedido.`,
        );
      }
    }

    // Coherencia con la sustitución: si viene nuevoPrecioCOId, no se puede estar
    // marcando PENDIENTE; se espera estado terminal (PARCIAL, COMPLETO, NO_DISPONIBLE).
    if (dto.nuevoPrecioCOId && dto.estadoSurtido === EstadoSurtido.PENDIENTE) {
      throw new BadRequestException(
        'Si se propone una sustitución (nuevoPrecioCOId), el estado no puede ser PENDIENTE.',
      );
    }

    const actualizado = await this.prisma.itemPedido.update({
      where: { id: itemId },
      data: {
        cantidadSurtida: dto.cantidadSurtida,
        estadoSurtido: dto.estadoSurtido,
        surtidoAt: new Date(),
        motivoSurtido: dto.motivo ?? null,
        sustitucionPropuestaPrecioCOId: dto.nuevoPrecioCOId ?? null,
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
   *   - Todos los items COMPLETO  → APPROVED
   *   - Algún item PARCIAL / NO_DISPONIBLE / con sustitución  → WAITING_CUSTOMER_APPROVAL
   *     con PedidoRevision creada automáticamente.
   *   - Al menos un item aún PENDIENTE  → 400 (debe completar todos los items)
   *
   * Notifica al cliente (REVISION_PROPUESTA) cuando se genera revisión.
   */
  async confirmarSurtido(pedidoId: number, usuario: UserContext, esAdmin: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({
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

      // Detectar faltantes: PARCIAL, NO_DISPONIBLE, o con sustitución propuesta.
      const itemsConFaltante = pedido.items.filter(
        (i) =>
          i.estadoSurtido === EstadoSurtido.PARCIAL ||
          i.estadoSurtido === EstadoSurtido.NO_DISPONIBLE ||
          i.sustitucionPropuestaPrecioCOId != null,
      );

      // F4 (jun 2026): no permitir pedidos con 0 productos activos.
      // Simula el resultado tras aplicar los cambios y cuenta cuántos
      // items activos quedarán. Si es 0, rechazar: bodega debe al menos
      // dejar un sustituto o cantidad > 0 en algún item.
      //
      // Reglas de conteo (espejo de `aplicarCambiosSurtido`):
      //   - Sustitución propuesta → cuenta 1 (se crea item nuevo).
      //   - NO_DISPONIBLE → cuenta 0 (se cancela).
      //   - PARCIAL con cantidadSurtida > 0 → cuenta 1.
      //   - PARCIAL con cantidadSurtida === 0 → cuenta 0.
      //   - COMPLETO → cuenta 1.
      //   - El resto (no en itemsConFaltante) son COMPLETO y cuentan 1.
      const itemsActivosFinales = pedido.items.reduce((acc, it) => {
        if (it.sustitucionPropuestaPrecioCOId) return acc + 1;
        if (it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) return acc;
        if (it.estadoSurtido === EstadoSurtido.PARCIAL) {
          return acc + (it.cantidadSurtida > 0 ? 1 : 0);
        }
        return acc + 1;
      }, 0);
      if (itemsActivosFinales === 0) {
        throw new BadRequestException(
          'No puedes confirmar el surtido: todos los productos quedarían cancelados o en 0 piezas. ' +
            'Agrega al menos un sustituto o ajusta la cantidad de algún item a >0 antes de confirmar.',
        );
      }

      if (itemsConFaltante.length === 0) {
        // Caso feliz: todo surtido, sin faltantes ni sustituciones
        const pedidoActualizado = await tx.pedido.update({
          where: { id: pedidoId },
          data: {
            // Encadenar REVIEWING → APPROVED → PENDING_PAID en una sola escritura.
            // La bodega libera el pedido al confirmar surtido: ya no espera pago.
            estado: EstadoPedido.PENDING_PAID,
            asignadoAId: null,
            asignadoAt: null,
          },
        });
        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior: EstadoPedido.REVIEWING,
            estadoNuevo: EstadoPedido.PENDING_PAID,
            observacion: 'Surtido confirmado completo — pendiente de pago',
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });
        await this.encolarEnvioAFirebird(tx, pedidoId);

        // Realtime: igual que el caso con faltantes, para que el monitor de
        // bodega libere el slot del bodeguero y el monitor de cajeros reciba
        // el pedido en su cola al instante (sin esperar el polling 5s).
        this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId });
        this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
          id: pedidoId,
          estadoAnterior: EstadoPedido.REVIEWING,
          estadoNuevo: EstadoPedido.PENDING_PAID,
        });

        this.logger.log(`Pedido ${pedidoId}: surtido completo → PENDING_PAID`);
        return {
          mensaje: 'Surtido completo confirmado',
          estado: EstadoPedido.PENDING_PAID,
          pedido: pedidoActualizado,
          cambiosAplicados: 0,
        };
      }

      // Hay faltantes. Aplicar los cambios directamente sobre el pedido
      // (mismo approach que `cerrarRevision` pero sin crear PedidoRevision).
      // Esto reemplaza el flujo formal de revisión: el chat es el canal de
      // negociación y bodega confirma el acuerdo al surtir.
      const cambios = await this.aplicarCambiosSurtido(tx, pedido, itemsConFaltante);

      const pedidoActualizado = await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.PENDING_PAID,
          asignadoAId: null,
          asignadoAt: null,
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.REVIEWING,
          estadoNuevo: EstadoPedido.PENDING_PAID,
          observacion: `Surtido confirmado con ${cambios.length} cambio(s) aplicado(s) — pendiente de pago`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });
      await this.encolarEnvioAFirebird(tx, pedidoId);

      this.logger.log(
        `Pedido ${pedidoId}: surtido con ${cambios.length} cambio(s) → PENDING_PAID`,
      );

      // Realtime: el monitor de bodega debe recomputar (ya no aplica al pedido)
      // y el monitor de ventanillas debe refrescar la cola.
      this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.REVIEWING,
        estadoNuevo: EstadoPedido.PENDING_PAID,
      });

      // Notificar al cliente: pedido aprobado con los cambios aplicados.
      // El cliente verá el resultado al refrescar (realtime invalida la query).
      const pedidoCompleto = await tx.pedido.findUnique({
        where: { id: pedidoId },
        include: { items: true },
      });
      if (pedidoCompleto) {
        setImmediate(() => {
          this.notifications
            .enviar(pedidoCompleto, TipoNotificacion.REVISION_APROBADA)
            .catch((err) =>
              this.logger.error(
                `Error enviando REVISION_APROBADA tras confirmarSurtido: ${err.message}`,
              ),
            );
        });
      }

      return {
        mensaje: `Surtido confirmado con ${cambios.length} cambio(s) aplicado(s)`,
        estado: EstadoPedido.PENDING_PAID,
        pedido: pedidoActualizado,
        cambiosAplicados: cambios.length,
      };
    });
  }

  /**
   * Aplica los cambios de bodega (cancelar NO_DISPONIBLES, ajustar PARCIALES,
   * crear sustituciones) sobre los items del pedido. Recalcula subtotal y
   * total. Helper extraído para que `confirmarSurtido` quede legible.
   *
   * Devuelve un array con la descripción de cada cambio aplicado (para el log).
   */
  private async aplicarCambiosSurtido(
    tx: Prisma.TransactionClient,
    pedido: { id: number; tiendaId: number },
    itemsConFaltante: Array<{
      id: number;
      cantidad: number;
      cantidadSurtida: number;
      estadoSurtido: EstadoSurtido;
      sustitucionPropuestaPrecioCOId: number | null;
      motivoSurtido: string | null;
    }>,
  ): Promise<string[]> {
    const cambios: string[] = [];

    for (const item of itemsConFaltante) {
      // Sustitución: cancelar el original y crear uno nuevo con el PrecioCO propuesto.
      if (item.sustitucionPropuestaPrecioCOId) {
        const nuevoPco = await tx.precioCO.findUnique({
          where: { id: item.sustitucionPropuestaPrecioCOId },
          include: { producto: true, talla: true, color: true, corrida: true },
        });
        if (!nuevoPco) {
          throw new NotFoundException(
            `PrecioCO ${item.sustitucionPropuestaPrecioCOId} no existe`,
          );
        }
        const cantidad = Math.max(1, item.cantidadSurtida || item.cantidad);
        const subtotal = new Prisma.Decimal(nuevoPco.precio).mul(cantidad);

        await tx.itemPedido.update({
          where: { id: item.id },
          data: { cancelada: true },
        });
        await tx.itemPedido.create({
          data: {
            pedidoId: pedido.id,
            productoId: nuevoPco.productoId,
            precioCOId: nuevoPco.id,
            cantidad,
            precioUnitario: nuevoPco.precio,
            subtotal,
            productoNombre: nuevoPco.producto.nombre,
            productoCodigo: nuevoPco.producto.codigo,
            corridaNombre: nuevoPco.corrida.nombre,
            tallaNombre: nuevoPco.talla.nombre,
            colorNombre: nuevoPco.color.nombre,
            original: false,
            cancelada: false,
          },
        });
        cambios.push(`Sustitución aplicada en item #${item.id}`);
        continue;
      }

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
        const itemActual = await tx.itemPedido.findUnique({ where: { id: item.id } });
        if (!itemActual) throw new NotFoundException(`Item ${item.id} no existe`);
        const nuevoSubtotal = new Prisma.Decimal(itemActual.precioUnitario).mul(nuevaCantidad);
        await tx.itemPedido.update({
          where: { id: item.id },
          data: { cantidad: nuevaCantidad, subtotal: nuevoSubtotal },
        });
        cambios.push(`Item #${item.id} ajustado a ${nuevaCantidad} piezas`);
      }
    }

    // Recalcular subtotal y total del pedido con items no cancelados.
    const itemsActuales = await tx.itemPedido.findMany({
      where: { pedidoId: pedido.id, cancelada: false },
    });
    const nuevoSubtotal = itemsActuales.reduce(
      (acc, i) => acc.plus(new Prisma.Decimal(i.subtotal)),
      new Prisma.Decimal(0),
    );
    await tx.pedido.update({
      where: { id: pedido.id },
      data: { subtotal: nuevoSubtotal, total: nuevoSubtotal },
    });

    void pedido; // (referencia por si se quiere usar en log)
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
        estado: {
          in: [
            EstadoPedido.REVIEWING,
            EstadoPedido.WAITING_CUSTOMER_APPROVAL,
            EstadoPedido.APPROVED,
          ],
        },
      },
    });
    return count < MAX_PEDIDOS_POR_BODEGUERO;
  }

  get maxPedidosPorBodeguero(): number {
    return MAX_PEDIDOS_POR_BODEGUERO;
  }

  // ---- helpers ----

  /**
   * Calcula los pedidos PENDING_REVIEW de la misma tienda que comparten items
   * (por producto) con el pedido dado. F10 (ago 2026): delega en
   * `rankearSimilares` (helper puro en core/similitud.util.ts) para no
   * duplicar la lógica con `BodegaService.obtenerSurtirJuntos`.
   */
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

  /**
   * Encola el pedido para descarga a Firebird. Se llama desde
   * confirmarSurtido (ambos caminos) DENTRO de la transacción, cuando el
   * pedido acaba de pasar a PENDING_PAID con sus cantidades finales.
   *
   * El agente lo baja vía poll-pedidos y GRABAR_PEDIDOS genera el folio
   * local (VFP), que se guarda en externalFolio en el ACK (doble folio:
   * la web mantiene su numeroPedido, VFP el suyo).
   *
   * externalIdPEDIDOS determinista (1B + pedidoId): aunque el SQLite del
   * agente se pierda, GRABAR_PEDIDOS recibe siempre el mismo ID y la SP lo
   * trata como UPDATE (idempotente).
   */
  private async encolarEnvioAFirebird(
    tx: Prisma.TransactionClient,
    pedidoId: number,
  ): Promise<void> {
    await tx.pedidoPendienteEnvio.create({
      data: {
        pedidoId,
        estado: 'PENDIENTE',
        // Offset 1B: los IDs Firebird típicos son <10M, así que 1B+id nube
        // evita colisión con IDs locales reales.
        externalIdPEDIDOS: 1_000_000_000 + pedidoId,
      },
    });
  }
}
