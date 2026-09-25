import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { resolverModoEntrega } from '../core/delivery-mode.util';
import { PreciosService } from '../../precios/precios.service';
import {
  precioDeLista,
  precioConPromoVolumen,
  COLUMNA_MAYOREO,
} from '../../precios/precio-lista.util';
import { KioskoService } from '../../kiosko/kiosko.service';
import { KioskoLlegadaService } from '../../kiosko/kiosko-llegada.service';
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
    private readonly storage: StorageService,
    private readonly kioskoService: KioskoService,
    private readonly kioskoLlegada: KioskoLlegadaService,
    private readonly precios: PreciosService,
  ) {}

  async crearPedido(
    dto: CreatePedidoDto,
    usuario: UserContext & { tiendaIdHeader?: number },
    idempotencyKey?: string,
    kioskoIdHeader?: number,
    /**
     * PR2 (kiosko-profesional): device token enviado por la tablet en
     * `X-Kiosko-Token`. Sin él, no se acepta un kioskoId del header —
     * cerrar el bug "cualquier cliente puede mentir que es kiosko".
     */
    kioskoDeviceToken?: string,
  ) {
    // Idempotencia: si llega la misma key, devolver el pedido existente
    if (idempotencyKey) {
      const existente = await this.prisma.pedido.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      if (existente) {
        if (existente.usuarioId !== usuario.userId) {
          throw new BadRequestException('La clave de idempotencia ya está en uso');
        }
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

    // Un cliente web/kiosko puede pedir en CUALQUIER tienda activa: no
    // pertenece a una tienda concreta. La membresía `usuarioTienda` (poblada
    // por Firebird) solo resuelve la lista de precios del cliente, no gatea
    // pedidos. La tienda del pedido es la que el cliente eligió (X-Tienda-Id).

    // KIOSKO: si el frontend manda X-Kiosko-Id, validamos contra BD y
    // forzamos canalOrigen=KIOSKO. Defensa en profundidad: un kiosko no
    // puede mentir sobre su origen porque validamos que exista, esté
    // ACTIVO, pertenezca a esta tienda Y que el `X-Kiosko-Token` enviado
    // coincida con el hash guardado (PR2 — antes bastaba con saber el
    // kioskoId, que es SERIAL enumerable).
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
      // Validar device token (timing-safe en el service).
      const tokenValido = await this.kioskoService.validarDeviceToken(
        kioskoIdHeader,
        kioskoDeviceToken,
      );
      if (!tokenValido) {
        // Mismo mensaje genérico para "no tiene token" y "token incorrecto"
        // — no queremos leak de "existe vs token mal".
        throw new BadRequestException(
          'Kiosko sin device token configurado o token inválido',
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
    };

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

    // Fase 0 (sep 2026): el precio del item se congela desde la lista de
    // precios DEL CLIENTE, no desde `pco.precio` (que es siempre lista1).
    // Antes el catálogo mostraba la lista correcta y el pedido se guardaba con
    // lista1: el cliente veía un precio y se le cobraba otro, con el error
    // congelado en `ItemPedido.precioUnitario` y viajando así al ERP.
    const columnaLista = await this.precios.columnaParaUsuario(usuario.userId, tiendaId);

    // Promo de volumen (sep 2026): 12+ piezas → lista 2. Se congela el par
    // (base, mayoreo) en cada item para que la promo se pueda re-evaluar
    // después sin releer `PrecioCO` — ver `promo-volumen.util.ts`.
    //
    // El precio efectivo sale de `precioConPromoVolumen`, la MISMA función que
    // usa la re-evaluación y el endpoint del carrito. Es la única forma de
    // garantizar que el precio congelado sea punto fijo del recálculo: con dos
    // gates distintos (uno por columna, otro por precio) el pedido cambiaría de
    // precio solo cuando Firebird tiene una lista sin capturar.
    const totalPiezas = dto.items.reduce((acc, i) => acc + i.cantidad, 0);

    let subtotal = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
      const pco = preciosCO.find((p) => p.id === item.precioCOId)!;
      const precioUnitarioBase = precioDeLista(pco, columnaLista);
      const precioUnitarioMayoreo = precioDeLista(pco, COLUMNA_MAYOREO);
      const precioUnitario = precioConPromoVolumen(
        precioUnitarioBase,
        precioUnitarioMayoreo,
        totalPiezas,
      );
      const itemSubtotal = precioUnitario.mul(item.cantidad);
      subtotal = subtotal.plus(itemSubtotal);
      return {
        productoId: pco.productoId,
        precioCOId: pco.id,
        cantidad: item.cantidad,
        // C4: snapshot de la cantidad original al crear el pedido. El handler
        // de MOVPED compara contra este valor para distinguir surtido COMPLETO
        // vs PARCIAL cuando el bodeguero ajusta cantidades en VFP.
        cantidadOriginal: item.cantidad,
        precioUnitario,
        precioUnitarioBase,
        precioUnitarioMayoreo,
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

    let pedido: any = null;
    for (let intento = 0; intento < 3 && !pedido; intento++) {
      const numeroPedido = await this.state.generarNumeroPedido();
      try {
        // El pedido vive SOLO en la nube hasta que bodega confirma el surtido
        // (confirmarSurtido → PENDING_PAID crea la entrada en pedidos_pendientes_envio).
        // Así Firebird sólo recibe pedidos con cantidades finales y no hace falta
        // re-sincronizar ajustes (trigger MOVPED eliminado).
        pedido = await this.prisma.pedido.create({
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
          },
          include: {
            items: true,
            tienda: true,
            kiosko: { select: { id: true, nombre: true } },
            pendienteEnvio: true,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        if (idempotencyKey) {
          const concurrente = await this.prisma.pedido.findUnique({
            where: { idempotencyKey },
            include: { items: true },
          });
          if (concurrente) {
            if (concurrente.usuarioId !== usuario.userId) {
              throw new BadRequestException('La clave de idempotencia ya está en uso');
            }
            pedido = concurrente;
          }
        }
      }
    }

    if (!pedido) {
      throw new ConflictException('No se pudo generar un número único de pedido');
    }

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
              precioCOId: true,
              original: true,
              cancelada: true,
              sustitucionPropuestaPrecioCOId: true,
            },
          },
          tienda: { select: { id: true, nombre: true } },
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
            producto: {
              select: {
                imagenPrincipal: true,
                imagenesProducto: { select: { url: true, colorId: true } },
              },
            },
            precioCO: { select: { colorId: true } },
          },
        },
        tienda: true,
        kiosko: { select: { id: true, nombre: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        mensajes: { where: { visibleParaCliente: true }, orderBy: { createdAt: 'asc' } },
        cajeroAsignado: { select: { id: true, nombre: true, apellido: true } },
        // F12: propuestas de ajuste para que el cliente vea y responda.
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
      },
    });
    if (!pedido) {
      // 404 (no 403) para no filtrar existencia del pedido a clientes ajenos.
      throw new NotFoundException('Pedido no encontrado');
    }
    // Adjuntar productoImagen a cada item del pedido: la imagen del color de
    // la variante (si el producto tiene imágenes asociadas a ese color);
    // fallback a la imagen principal del producto.
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
    return pedido;
  }

  async cancelarPedido(pedidoId: number, usuarioId: number, usuario: UserContext) {
    return this.state.cambiarEstado(
      pedidoId,
      { nuevoEstado: EstadoPedido.CANCELLED, observacion: 'Cancelado por el cliente' },
      usuario,
    );
  }

  // PR7: el cliente avisa llegada desde la app/web autenticado. Como
  // ya validamos `usuarioId === user.userId` en el controller, el
  // service solo valida estado y modo de entrega. La lógica de
  // escritura + realtime vive en KioskoLlegadaService (mismo path
  // que kiosko) pero sin requerir X-Kiosko-Id/X-Kiosko-Token.
  async anunciarLlegada(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        estado: true,
        modoEntrega: true,
        tiendaId: true,
        usuarioId: true,
      },
    });
    if (!pedido || pedido.usuarioId !== usuarioId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (
      pedido.modoEntrega !== ModoEntrega.RECOGER_TIENDA &&
      pedido.modoEntrega !== ModoEntrega.KIOSKO
    ) {
      throw new BadRequestException('Este pedido no es para recoger en tienda');
    }

    // F16 (sep 2026): solo se puede avisar llegada cuando el pedido YA ESTÁ
    // LISTO para revisarse en tienda, es decir en `EN_MOSTRADOR`.
    //
    // Ese estado es exactamente el punto en que bodega terminó de verificar
    // (aprobó el pedido tal cual), o el cliente aprobó las modificaciones que
    // bodega o ventas propusieron. Antes de eso el pedido no está apartado, así
    // que avisar no tendría sentido: el mostrador no tiene nada que mostrarle.
    //
    // Antes solo se rechazaban COMPLETED y CANCELLED, así que el cliente podía
    // avisar desde PENDING_REVIEW — y el pedido quedaba marcado "EN TIENDA"
    // antes de que nadie lo hubiera surtido.
    if (pedido.estado !== EstadoPedido.EN_MOSTRADOR) {
      const mensajes: Partial<Record<EstadoPedido, string>> = {
        [EstadoPedido.PENDING_REVIEW]:
          'Tu pedido todavía está en cola de revisión. Te avisaremos cuando esté listo.',
        [EstadoPedido.REVIEWING]:
          'Bodega está preparando tu pedido. Podrás avisar tu llegada cuando esté listo.',
        [EstadoPedido.WAITING_CUSTOMER_APPROVAL]:
          'Tienes una propuesta pendiente de aprobar. Tu pedido estará listo cuando la respondas.',
        [EstadoPedido.EN_ASESORIA]:
          'Un asesor está viendo tu pedido. Podrás avisar tu llegada cuando esté listo.',
        [EstadoPedido.PENDING_PAID]:
          'Tu pedido ya pasó a caja. Pasa a la ventanilla que te indiquen.',
        [EstadoPedido.PAID]:
          'Tu pedido ya está pagado. Pasa a mostrador a recogerlo.',
        [EstadoPedido.SHIPPED]:
          'Tu pedido ya fue enviado.',
        [EstadoPedido.COMPLETED]: 'Ese pedido ya fue entregado.',
        [EstadoPedido.CANCELLED]: 'Ese pedido está cancelado.',
      };
      throw new BadRequestException(
        mensajes[pedido.estado] ??
          'Tu pedido todavía no está listo para revisarse en tienda.',
      );
    }

    return this.kioskoLlegada.confirmarDesdeCliente(pedidoId);
  }
}
