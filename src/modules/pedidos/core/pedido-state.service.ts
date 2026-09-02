import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from './pedido-access.service';
import { asignadoANombre } from './pedido-mapper';
import { CambiarEstadoDto } from '../admin/dto/cambiar-estado.dto';
import { UserContext } from '../../../types/pedido.types';
import {
  EstadoPedido,
  TipoNotificacion,
} from '@prisma/client';

/**
 * Máquina de estados B2B. Cada estado declara a qué otros puede transicionar.
 * El cliente sólo puede cancelar antes de PAID.
 *
 * Flujo de pago (jun 2026): la tienda cobra en un sistema externo (Visual FoxPro +
 * Firebird). El backend sólo registra cuándo se cobró vía webhook autenticado
 * (`POST /admin/pedidos/:id/marcar-pagado`). REVIEWING → PENDING_PAID es una
 * transición disparada por `SurtidoService.confirmarSurtido` (sin acción humana)
 * o por `PropuestaService` cuando el cliente acepta la propuesta.
 */
const TRANSICIONES: Record<EstadoPedido, EstadoPedido[]> = {
  [EstadoPedido.PENDING_REVIEW]: [EstadoPedido.REVIEWING, EstadoPedido.CANCELLED],
  [EstadoPedido.REVIEWING]: [
    // REVIEWING → WAITING_CUSTOMER_APPROVAL: lo dispara PropuestaService
    // cuando bodega envía una propuesta (hay faltantes). El pedido sigue
    // asignado al bodeguero y el reloj de atención se pausa.
    EstadoPedido.WAITING_CUSTOMER_APPROVAL,
    // REVIEWING → PENDING_PAID: lo dispara SurtidoService.confirmarSurtido
    // cuando la bodega cierra el surtido SIN faltantes. El pedido queda listo
    // para pago; la transición y los cambios de items son atómicos.
    EstadoPedido.PENDING_PAID,
    EstadoPedido.CANCELLED,
  ],
  // F12 (sep 2026): WAITING_CUSTOMER_APPROVAL es un estado REAL. El cliente
  // acepta (→ PENDING_PAID, aplica cambios) o rechaza (→ REVIEWING, re-trabaja).
  // El admin puede forzar la aprobación (→ PENDING_PAID). El bodeguero puede
  // liberar el pedido de vuelta a la cola (→ REVIEWING sin asignar) si el
  // cliente no responde.
  [EstadoPedido.WAITING_CUSTOMER_APPROVAL]: [
    EstadoPedido.PENDING_PAID,
    EstadoPedido.REVIEWING,
    EstadoPedido.CANCELLED,
  ],
  [EstadoPedido.PENDING_PAID]: [EstadoPedido.PAID, EstadoPedido.CANCELLED],
  // PAID → SHIPPED sólo aplica a pedidos a domicilio (con shippingDireccion).
  // Kiosko y web recoger en tienda saltan directo a COMPLETED vía el módulo
  // Mostrador. La validación de shippingDireccion ocurre en `marcarEnviado`.
  [EstadoPedido.PAID]: [EstadoPedido.SHIPPED, EstadoPedido.COMPLETED, EstadoPedido.CANCELLED],
  [EstadoPedido.SHIPPED]: [EstadoPedido.COMPLETED, EstadoPedido.CANCELLED],
  [EstadoPedido.COMPLETED]: [],
  [EstadoPedido.CANCELLED]: [],
};

/**
 * Fuente única de verdad de la máquina de estados de un pedido.
 *
 * Lo consumen:
 *   - `cliente/cliente.service.ts` — `generarNumeroPedido` al crear.
 *   - `bodega/bodega.service.ts` — `cambiarEstado` al tomar / marcar enviado.
 *   - `bodega/surtido.service.ts` — `cambiarEstado` al confirmar surtido.
 *   - `cajero/cajero.service.ts` — no (sus acciones son asignaciones, no transiciones).
 *   - `admin/admin.service.ts` — `cambiarEstado` al marcar como pagado.
 *   - `messages/messages.service.ts` — no.
 *   - `mostrador/mostrador.service.ts` — `cambiarEstado` al entregar.
 *
 * Si cambia la máquina de estados, los side-effects (historial, realtime,
 * notificación) se actualizan en un solo archivo.
 */
@Injectable()
export class PedidoStateService {
  private readonly logger = new Logger(PedidoStateService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
  ) {}

  /**
   * Cambia el estado de un pedido validando la transición, registrando historial
   * y ejecutando side-effects (timestamps, etc.).
   *
   * Público para que módulos hermanos (mostrador, paquetería futura) puedan
   * orquestar transiciones sin reimplementar la lógica de historial/realtime/
   * notificación. **No llamar directamente desde controllers** — usar los
   * wrappers de dominio (`marcarEnviado`, `entregarEnMostrador`, etc.) que
   * aplican las validaciones de acceso correspondientes.
   */
  async cambiarEstado(
    pedidoId: number,
    dto: CambiarEstadoDto,
    usuario: UserContext,
  ) {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const estadoAnterior = pedido.estado;
      const estadoNuevo = dto.nuevoEstado;

      const permitidas = TRANSICIONES[estadoAnterior];
      if (!permitidas.includes(estadoNuevo)) {
        throw new BadRequestException(
          `Transición no permitida: ${estadoAnterior} → ${estadoNuevo}`,
        );
      }

      const result = await tx.pedido.updateMany({
        where: { id: pedidoId, estado: estadoAnterior },
        data: {
          estado: estadoNuevo,
          ...(estadoNuevo === EstadoPedido.REVIEWING && {
            asignadoAId: usuario.userId,
            asignadoAt: new Date(),
            // F12: al tomar el pedido arranca el reloj de atención del bodeguero.
            bodegaTurnoDesdeAt: new Date(),
          }),
        },
      });
      if (result.count !== 1) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla e inténtalo de nuevo.',
        );
      }
      const pedidoActualizado = await tx.pedido.findUnique({
        where: { id: pedidoId },
      });
      if (!pedidoActualizado) {
        throw new NotFoundException('Pedido no encontrado');
      }

      // Al tomar un pedido (transición a REVIEWING) se asigna el bodeguero
      // que lo está trabajando. Queda registrado para el monitor de bodega.

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior,
          estadoNuevo,
          observacion: dto.observacion || `Cambio de estado por ${usuario.nombre}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.logger.log(`Pedido ${pedidoId}: ${estadoAnterior} → ${estadoNuevo} (por ${usuario.nombre})`);

      // Realtime: notificar a la tienda y al room del pedido.
      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior,
        estadoNuevo,
        asignadoAId: pedidoActualizado.asignadoAId,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior,
        estadoNuevo,
      });

      // Notificar al cliente según el estado nuevo
      const notifTipo = this.notifTipoParaEstado(estadoNuevo);
      if (notifTipo) {
        const pedidoCompleto = await tx.pedido.findUnique({ where: { id: pedidoId } });
        if (pedidoCompleto) {
          // Fire-and-forget fuera de la transacción
          setImmediate(() => {
            this.notifications.enviar(pedidoCompleto, notifTipo).catch((err) =>
              this.logger.error(`Error enviando notificación ${notifTipo}: ${err.message}`),
            );
          });
        }
      }

      return pedidoActualizado;
    });
  }

  /**
   * Transición de estado disparada por un sistema externo (agente Firebird),
   * sin guards de rol humano. Reutiliza la máquina de estados (TRANSICIONES)
   * + historial + realtime + notificación, para que ninguna vía de cambio de
   * estado duplique o salte la validación de transiciones.
   *
   * No valida acceso (el caller ya lo hizo o es un sistema de confianza).
   */
  async cambiarEstadoPorSistema(
    pedidoId: number,
    nuevoEstado: EstadoPedido,
    opts: { observacion?: string; usuarioNombre?: string } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      const estadoAnterior = pedido.estado;
      if (estadoAnterior === nuevoEstado) return pedido;

      const permitidas = TRANSICIONES[estadoAnterior];
      if (!permitidas.includes(nuevoEstado)) {
        throw new BadRequestException(
          `Transición no permitida: ${estadoAnterior} → ${nuevoEstado}`,
        );
      }

      const result = await tx.pedido.updateMany({
        where: { id: pedidoId, estado: estadoAnterior },
        data: { estado: nuevoEstado },
      });
      if (result.count !== 1) {
        throw new ConflictException(
          'El pedido cambió mientras se procesaba. Actualiza la pantalla e inténtalo de nuevo.',
        );
      }
      const pedidoActualizado = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedidoActualizado) throw new NotFoundException('Pedido no encontrado');

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior,
          estadoNuevo: nuevoEstado,
          observacion: opts.observacion || `Cambio de estado por ${opts.usuarioNombre ?? 'sistema'}`,
          usuarioId: null,
          usuarioNombre: opts.usuarioNombre ?? 'SISTEMA',
        },
      });

      this.logger.log(
        `Pedido ${pedidoId}: ${estadoAnterior} → ${nuevoEstado} (por ${opts.usuarioNombre ?? 'sistema'})`,
      );

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior,
        estadoNuevo: nuevoEstado,
        asignadoAId: pedidoActualizado.asignadoAId,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior,
        estadoNuevo: nuevoEstado,
      });

      const notifTipo = this.notifTipoParaEstado(nuevoEstado);
      if (notifTipo) {
        const pedidoCompleto = await tx.pedido.findUnique({ where: { id: pedidoId } });
        if (pedidoCompleto) {
          setImmediate(() => {
            this.notifications.enviar(pedidoCompleto, notifTipo).catch((err) =>
              this.logger.error(`Error enviando notificación ${notifTipo}: ${err.message}`),
            );
          });
        }
      }

      return pedidoActualizado;
    });
  }

  /**
   * Genera el siguiente número de pedido con el formato `PD-YYYY-NNNNNN`.
   * Se calcula a partir del último pedido del año en curso (no usa secuencia
   * de BD para mantenerlo portable entre migraciones).
   */
  async generarNumeroPedido(): Promise<string> {
    const year = new Date().getFullYear();
    const ultimo = await this.prisma.pedido.findFirst({
      where: { numeroPedido: { startsWith: `PD-${year}-` } },
      orderBy: { id: 'desc' },
    });
    let n = 1;
    if (ultimo) {
      const partes = ultimo.numeroPedido.split('-');
      const u = parseInt(partes[2], 10);
      if (!isNaN(u)) n = u + 1;
    }
    return `PD-${year}-${n.toString().padStart(6, '0')}`;
  }

  /**
   * Devuelve el detalle completo de un pedido con items, mensajes, historial y
   * asignado. Si llega `usuario`, valida acceso (no-admin debe pertenecer a la
   * tienda o ser el dueño).
   *
   * Lo consumen: cliente (su pedido), bodega (cualquier pedido de su tienda),
   * cajero, admin y mostrador.
   */
  async obtenerDetalle(pedidoId: number, usuario?: UserContext) {
    if (usuario) {
      await this.access.cargarYValidar(pedidoId, usuario);
    }
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
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
        usuario: { select: { id: true, nombre: true, email: true, telefono: true } },
        // F4 (jul 2026): incluimos el bodeguero asignado para que la UI pueda
        // mostrar "asignado a {nombre}" en badges y deshabilitar CTAs cuando
        // el pedido está siendo surtido por otro bodeguero. Permitido en
        // REVIEWING sin asignar (devuelve null).
        asignadoA: { select: { id: true, nombre: true, apellido: true } },
        historial: { orderBy: { createdAt: 'asc' } },
        mensajes: { orderBy: { createdAt: 'asc' } },
        // F12: propuestas de ajuste (historial de negociación).
        propuestas: {
          orderBy: { enviadaAt: 'asc' },
          include: {
            creadaPor: { select: { id: true, nombre: true, apellido: true } },
            forzadaPor: { select: { id: true, nombre: true, apellido: true } },
          },
        },
        // QR: el folio VFP (externalFolio) se expone para que el frontend
        // muestre el QR y el folio visible. Solo existe tras el ACK del agente.
        pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    pedido.items = pedido.items.map((it: any) => {
      const imagenColor = it.producto?.imagenesProducto?.find(
        (img: any) => img.colorId === it.precioCO?.colorId,
      )?.url;
      return {
        ...it,
        productoImagen: imagenColor ?? it.producto?.imagenPrincipal ?? null,
      };
    }) as any;
    (pedido as any).asignadoANombre = asignadoANombre((pedido as any).asignadoA);
    return pedido;
  }

  private notifTipoParaEstado(estado: EstadoPedido): TipoNotificacion | null {
    switch (estado) {
      case EstadoPedido.WAITING_CUSTOMER_APPROVAL: return TipoNotificacion.REVISION_PROPUESTA;
      // PENDING_PAID no notifica al cliente: el cambio lo ve por realtime/refresh
      // cuando bodega confirma el surtido o el cliente acepta la propuesta.
      case EstadoPedido.PAID: return TipoNotificacion.PAGO_CONFIRMADO;
      case EstadoPedido.SHIPPED: return TipoNotificacion.ENVIADO;
      case EstadoPedido.COMPLETED: return TipoNotificacion.ENTREGADO;
      case EstadoPedido.CANCELLED: return TipoNotificacion.CANCELADO;
      default: return null;
    }
  }
}
