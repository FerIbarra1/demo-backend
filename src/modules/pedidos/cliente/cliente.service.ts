import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { resolverModoEntrega } from '../core/delivery-mode.util';
import { isValidPickupSlot } from '../core/pickup-slot.util';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { UserContext } from '../../../types/pedido.types';
import {
  EstadoPedido,
  TipoNotificacion,
  Prisma,
  CanalOrigen,
  ModoEntrega,
} from '@prisma/client';

/**
 * Servicio del dominio CLIENTE.
 *
 * Responsabilidad: crear pedidos (web + kiosko), listar/buscar mis pedidos,
 * cancelar mi pedido. Cualquier acción de cambio de estado delega a
 * `PedidoStateService` para mantener una sola fuente de verdad.
 */
@Injectable()
export class ClienteService {
  private readonly logger = new Logger(ClienteService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private state: PedidoStateService,
  ) {}

  async crearPedido(
    dto: CreatePedidoDto,
    usuario: UserContext & { tiendaIdHeader?: number },
    idempotencyKey?: string,
    kioskoIdHeader?: number,
  ) {
    // Idempotencia: si llega la misma key, devolver el pedido existente
    if (idempotencyKey) {
      const existente = await this.prisma.pedido.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      if (existente) {
        this.logger.log(`Idempotency hit para key ${idempotencyKey} → pedido ${existente.id}`);
        return { ...existente, mensaje: 'Pedido (idempotente)' };
      }
    }

    // B2B multi-tienda: la tienda del pedido es la que el cliente
    // seleccionó activamente (header `X-Tienda-Id` enviado por el frontend).
    // Si no viene, caemos a la tienda asignada al usuario.
    const tiendaId = usuario.tiendaIdHeader ?? usuario.tiendaId;

    if (!tiendaId) {
      throw new BadRequestException('Debe seleccionar una tienda para crear el pedido');
    }

    const tienda = await this.prisma.tienda.findFirst({
      where: { id: tiendaId, activa: true },
    });
    if (!tienda) {
      throw new BadRequestException('La tienda seleccionada no está disponible');
    }

    // KIOSKO: si el frontend manda X-Kiosko-Id, validamos contra BD y
    // forzamos canalOrigen=KIOSKO. Defensa en profundidad: un kiosko no
    // puede mentir sobre su origen porque validamos que exista, esté
    // ACTIVO y pertenezca a esta tienda.
    let kioskoIdFinal: number | null = null;
    let canalOrigenFinal: CanalOrigen = dto.canalOrigen ?? CanalOrigen.WEB;

    if (kioskoIdHeader) {
      const kiosko = await this.prisma.kiosko.findFirst({
        where: { id: kioskoIdHeader, tiendaId, estado: 'ACTIVO' },
      });
      if (!kiosko) {
        throw new BadRequestException(
          'Kiosko inválido o inactivo para esta tienda',
        );
      }
      kioskoIdFinal = kiosko.id;
      canalOrigenFinal = CanalOrigen.KIOSKO;
    }

    // Si el cliente intenta mandar KIOSKO sin kioskoId real → reject.
    // Sólo permitimos que dto.canalOrigen diga KIOSKO si fue forzado por
    // un kioskoIdHeader válido (ya validado arriba).
    if (dto.canalOrigen === CanalOrigen.KIOSKO && !kioskoIdFinal) {
      throw new BadRequestException(
        'Para pedidos de kiosko se requiere un kiosko activo (header X-Kiosko-Id)',
      );
    }

    // F8 (jul 2026): validación centralizada del modo de entrega.
    const modoEntregaFinal = resolverModoEntrega(
      dto,
      canalOrigenFinal,
      kioskoIdFinal,
    );

    // A partir de aquí, modoEntregaFinal es la fuente de verdad. Limpiamos
    // los campos de envío que no aplican para no almacenarlos.
    const envioFields = {
      shippingDireccion:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingDireccion?.trim() || null : null,
      shippingReferencia:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingReferencia?.trim() || null : null,
      shippingColonia:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingColonia?.trim() || null : null,
      shippingCodigoPostal:
        modoEntregaFinal === ModoEntrega.DOMICILIO ? dto.shippingCodigoPostal?.trim() || null : null,
      shippingPaqueteria:
        modoEntregaFinal === ModoEntrega.DOMICILIO && !dto.dejarAdminDecidePaqueteria
          ? dto.shippingPaqueteria ?? null
          : null,
      dejarAdminDecidePaqueteria:
        modoEntregaFinal === ModoEntrega.DOMICILIO && dto.dejarAdminDecidePaqueteria === true,
      recogerProgramado:
        modoEntregaFinal === ModoEntrega.RECOGER_TIENDA && dto.recogerProgramado
          ? new Date(dto.recogerProgramado)
          : null,
    };

    // Validar que el slot de recogida es válido (defensa en profundidad: el
    // frontend no debería mandar slots inválidos).
    if (envioFields.recogerProgramado && !isValidPickupSlot(envioFields.recogerProgramado)) {
      throw new BadRequestException(
        'El horario de recogida seleccionado no es válido. Elige otro slot disponible.',
      );
    }

    const preciosCO = await this.prisma.precioCO.findMany({
      where: {
        id: { in: dto.items.map((i) => i.precioCOId) },
        tiendaId,
      },
      include: { producto: true, talla: true, color: true, corrida: true },
    });

    if (preciosCO.length !== dto.items.length) {
      throw new BadRequestException('Algunos productos no están disponibles en esta tienda');
    }

    let subtotal = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
      const pco = preciosCO.find((p) => p.id === item.precioCOId)!;
      const itemSubtotal = new Prisma.Decimal(pco.precio).mul(item.cantidad);
      subtotal = subtotal.plus(itemSubtotal);
      return {
        productoId: pco.productoId,
        precioCOId: pco.id,
        cantidad: item.cantidad,
        precioUnitario: pco.precio,
        subtotal: itemSubtotal,
        productoNombre: pco.producto.nombre,
        productoCodigo: pco.producto.codigo,
        corridaNombre: pco.corrida.nombre,
        tallaNombre: pco.talla.nombre,
        colorNombre: pco.color.nombre,
        original: true,
        cancelada: false,
      };
    });

    const numeroPedido = await this.state.generarNumeroPedido();

    const pedido = await this.prisma.pedido.create({
      data: {
        numeroPedido,
        usuarioId: usuario.userId,
        tiendaId,
        estado: EstadoPedido.PENDING_REVIEW,
        canalOrigen: canalOrigenFinal,
        kioskoId: kioskoIdFinal,
        modoEntrega: modoEntregaFinal,
        ...envioFields,
        subtotal,
        total: subtotal,
        clienteNombre: dto.clienteNombre,
        clienteEmail: dto.clienteEmail,
        clienteTelefono: dto.clienteTelefono,
        notas: dto.notas,
        idempotencyKey,
        items: { create: itemsData },
        historial: {
          create: {
            estadoNuevo: EstadoPedido.PENDING_REVIEW,
            observacion: kioskoIdFinal
              ? `Pedido creado desde kiosko ${kioskoIdFinal}`
              : 'Pedido creado por cliente',
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        },
        // F9 (ago 2026): encolar pedido para sincronización con Firebird.
        // El agente local (en el servidor central de Firebird) lo sondea
        // y lo baja via GRABAR_PEDIDOS + GRABAR_MOVPED.
        pendienteEnvio: {
          create: { estado: 'PENDIENTE' },
        },
      },
      include: {
        items: true,
        tienda: true,
        kiosko: { select: { id: true, nombre: true } },
        pendienteEnvio: true,
      },
    });

    this.logger.log(
      `Pedido ${pedido.numeroPedido} creado (PENDING_REVIEW, canal=${pedido.canalOrigen}, kioskoId=${pedido.kioskoId ?? '-'})`,
    );

    // Realtime: notificar a la tienda (monitor + tablets de bodega).
    this.realtime.emitToTienda(pedido.tiendaId, 'pedido.creado', {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      canalOrigen: pedido.canalOrigen,
    });

    // Fire-and-forget: no bloqueamos la respuesta del cliente si el email tarda
    void this.notifications.enviar(pedido as any, TipoNotificacion.PEDIDO_RECIBIDO).catch((err) =>
      this.logger.error(`Error enviando notificación PEDIDO_RECIBIDO: ${err.message}`),
    );

    return { ...pedido, mensaje: 'Pedido creado exitosamente' };
  }

  async obtenerMisPedidos(usuarioId: number, pagina = 1, limite = 10) {
    const skip = (pagina - 1) * limite;
    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where: { usuarioId },
        include: {
          items: {
            select: {
              id: true,
              productoNombre: true,
              tallaNombre: true,
              colorNombre: true,
              cantidad: true,
              precioUnitario: true,
            },
          },
          tienda: { select: { nombre: true } },
          kiosko: { select: { id: true, nombre: true } },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where: { usuarioId } }),
    ]);
    return {
      data: pedidos,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  async obtenerMiPedido(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findFirst({
      where: { id: pedidoId, usuarioId },
      include: {
        items: {
          include: {
            producto: { select: { imagenPrincipal: true } },
          },
        },
        tienda: true,
        kiosko: { select: { id: true, nombre: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        mensajes: { where: { visibleParaCliente: true }, orderBy: { createdAt: 'asc' } },
        cajeroAsignado: { select: { id: true, nombre: true, apellido: true } },
      },
    });
    if (!pedido) {
      // 404 (no 403) para no filtrar existencia del pedido a clientes ajenos.
      throw new NotFoundException('Pedido no encontrado');
    }
    // Adjuntar productoImagen a cada item del pedido (imagen del producto original).
    pedido.items = pedido.items.map((it: any) => ({
      ...it,
      productoImagen: it.producto?.imagenPrincipal ?? null,
    })) as any;
    return pedido;
  }

  async cancelarPedido(pedidoId: number, usuarioId: number, usuario: UserContext) {
    return this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.CANCELLED, observacion: 'Cancelado por el cliente' },
      usuario,
    );
  }
}
