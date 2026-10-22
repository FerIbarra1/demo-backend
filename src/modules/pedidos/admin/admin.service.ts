import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { yaFueCobrado } from '../core/cobro.util';
import {
  ACTOR_AGENTE,
  emitirCambioDePago,
  pagoActivoDe,
  resolverPagoAlCobrarse,
} from '../../pagos/transferencia/hooks';
import { ESTADOS_NO_COBRAR } from '../../pagos/transferencia/reglas';
import { UserContext } from '../../../types/pedido.types';
import { reflejarCobroManualEnErp } from '../core/tareas-erp.util';
import { EstadoPedido, Prisma, TipoNotificacion } from '@prisma/client';

/**
 * Servicio del dominio ADMIN.
 *
 * Responsabilidad: listar todos los pedidos con filtros, ver detalle
 * completo, eliminar cancelados, ver historial, y confirmar pagos
 * (manual o vía webhook del sistema externo Firebird). El detalle de
 * pedido lo reutiliza `PedidoStateService.obtenerDetalle` para que
 * bodega/cajero/mostrador/cliente vean la misma estructura.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
  ) {}

  async obtenerTodosPedidos(filtros?: {
    tiendaId?: number;
    estado?: EstadoPedido;
    fechaInicio?: Date;
    fechaFin?: Date;
    pagina?: number;
    limite?: number;
  }) {
    const { tiendaId, estado, fechaInicio, fechaFin, pagina = 1, limite = 20 } = filtros || {};
    const skip = (pagina - 1) * limite;
    const where: Prisma.PedidoWhereInput = {};
    if (tiendaId) where.tiendaId = tiendaId;
    if (estado) where.estado = estado;
    if (fechaInicio || fechaFin) {
      where.fechaPedido = {};
      if (fechaInicio) where.fechaPedido.gte = fechaInicio;
      if (fechaFin) where.fechaPedido.lte = fechaFin;
    }

    const [pedidos, total] = await Promise.all([
      this.prisma.pedido.findMany({
        where,
        include: {
          items: {
            select: { id: true, productoNombre: true, cantidad: true, precioUnitario: true },
          },
          tienda: { select: { nombre: true } },
          usuario: { select: { nombre: true, email: true } },
        },
        orderBy: { fechaPedido: 'desc' },
        skip,
        take: limite,
      }),
      this.prisma.pedido.count({ where }),
    ]);

    return {
      data: pedidos,
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /**
   * Reutiliza el detalle compartido de `PedidoStateService.obtenerDetalle`
   * (que es el mismo que ven bodega, cajero, mostrador y cliente).
   * Mantiene la firma con `usuario?` para no romper controllers que ya
   * lo invocan sin pasarlo (admin sin filtro de tienda).
   */
  obtenerDetalle(pedidoId: number, usuario?: UserContext) {
    return this.state.obtenerDetalle(pedidoId, usuario);
  }

  async eliminarPedidoCancelado(pedidoId: number, usuario: UserContext) {
    // ADMIN only — el controller ya filtra por rol, pero defendemos en service.
    await this.access.cargarYValidar(pedidoId, usuario);
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    if (pedido.estado !== EstadoPedido.CANCELADO) {
      throw new BadRequestException('Solo se pueden eliminar pedidos en estado CANCELADO');
    }
    // Oct 2026: con una tarea abierta, el Sistema Comercial todavía tiene el pedido vivo y borrarlo de la web
    // borraría también el único recordatorio de cancelarlo allá.
    const abiertas = await this.prisma.tareaSistemaComercial.count({
      where: { pedidoId, estado: 'PENDIENTE' },
    });
    if (abiertas > 0) {
      throw new ConflictException(
        'Este pedido tiene pendientes en el Sistema Comercial. Ciérralos antes de eliminarlo.',
      );
    }
    await this.prisma.pedido.delete({ where: { id: pedidoId } });
    return { mensaje: 'Pedido eliminado', pedidoId };
  }

  async obtenerHistorialPedido(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.prisma.historialPedido.findMany({
      where: { pedidoId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Marca un pedido como pagado. Lo llama el handler del agente (cobro en VFP) y, como
   * herramienta de soporte, un ADMIN a mano.
   *
   * Oct 2026 (Fase 0 de pagos por transferencia), dos cosas que estaban mal:
   *
   * 1. **Podía resucitar un pedido terminal.** El `updateMany` filtraba por
   *    `estado: { not: PAGADO }` (el comentario decía que usaba `estadoAnterior`; el código
   *    no). Si el pedido se cancelaba entre la lectura y la escritura, el `where` seguía
   *    cumpliéndose y `CANCELADO → PAGADO`. Ahora la escritura lleva el estado que se
   *    LEYÓ dentro de la misma transacción: si cambió, no escribe.
   * 2. **Un pedido `ENVIADO` retrocedía a `PAGADO`.** Solo `PAGADO` contaba como "ya
   *    cobrado", y el agente puede llamar desde cualquier estado no terminal. Ver
   *    `cobro.util.ts`.
   *
   * Idempotente: si el pedido ya pasó por el cobro, devuelve el pedido sin tocar nada ni
   * volver a emitir (ni correo, ni realtime, ni historial).
   */
  async marcarComoPagado(
    pedidoId: number,
    body: { fechaPago?: string; referencia?: string; forzar?: boolean } | undefined,
    usuario: UserContext,
  ) {
    // Validar propiedad: ADMIN o sistema externo. Si es ADMIN humano,
    // validar tienda. Si es el agente externo (no tiene tienda), solo
    // validar que el pedido exista.
    const pedido = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    if (yaFueCobrado(pedido.estado)) {
      return pedido;
    }
    // El agente externo (Firebird) inyecta userId=0 vía ApiKeyGuard. Puede
    // marcar pagado un pedido desde cualquier estado no-terminal: en VFP el
    // cobro ya ocurrió, no tiene sentido rechazar por el estado de la nube.
    //
    // F13: PERO solo si el pedido ya llegó a Firebird. Un pedido en
    // EN_ASESORIA o ESPERANDO_APROBACION nunca se encoló (la fila de
    // `PedidoPendienteEnvio` se crea al pasar a PENDIENTE_PAGO), así que no
    // existe en el ERP: marcarlo PAGADO dejaría un pedido pagado sin folio, sin
    // items confirmados y sin nada que cobrar. Se exige la fila de cola.
    const esAgente = usuario.userId === 0;
    if (pedido.estado !== EstadoPedido.PENDIENTE_PAGO) {
      if (!esAgente || pedido.estado === EstadoPedido.CANCELADO) {
        throw new BadRequestException(
          `Solo se marca como pagado un pedido en PENDIENTE_PAGO (actual: ${pedido.estado})`,
        );
      }
      // El agente solo puede saltarse el gate si el pedido ya fue encolado a
      // Firebird (es decir, pasó por PENDIENTE_PAGO en algún momento).
      const encolado = await this.prisma.pedidoPendienteEnvio.findUnique({
        where: { pedidoId },
        select: { id: true },
      });
      if (!encolado) {
        throw new BadRequestException(
          `El pedido ${pedidoId} nunca llegó a Firebird (estado ${pedido.estado}); ` +
            'no se puede marcar como pagado.',
        );
      }
    }

    if (usuario.tiendaId && pedido.tiendaId !== usuario.tiendaId) {
      throw new BadRequestException('El pedido no pertenece a tu tienda');
    }

    const fechaPago = body?.fechaPago ? new Date(body.fechaPago) : new Date();
    if (isNaN(fechaPago.getTime())) {
      throw new BadRequestException('fechaPago inválido');
    }

    const referencia = body?.referencia?.trim() || undefined;

    // Oct 2026 (pagos por transferencia): un ADMIN no cobra a mano un pedido que tiene una
    // transferencia en curso sin saber lo que hace. Cobrar en caja con una transferencia abierta
    // puede ser un doble pago. El cobro de VFP (el agente) nunca se bloquea: ya ocurrió.
    if (!esAgente) {
      const pago = await pagoActivoDe(this.prisma, pedidoId);
      if (pago && ESTADOS_NO_COBRAR.includes(pago.estado)) {
        if (!body?.forzar || !referencia) {
          throw new ConflictException(
            `Este pedido tiene una transferencia en curso (${pago.estado}). Si aun así quieres ` +
              'cobrarlo a mano, manda `forzar: true` y explica el motivo en `referencia`.',
          );
        }
      }
    }

    const resultado = await this.prisma.$transaction(async (tx) => {
      // El estado se LEE aquí, dentro de la transacción, y es el que se usa de guarda
      // en la escritura y en el historial. Con el estado leído antes de abrirla, un
      // cambio en medio (cancelación, envío) pasaba desapercibido.
      const actual = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!actual) throw new NotFoundException('Pedido no encontrado');

      // Idempotencia: otro proceso lo cobró entre la primera lectura y ahora.
      if (yaFueCobrado(actual.estado)) return { yaPagado: true as const, pedido: actual };

      // Un pedido que se canceló en medio NO se revive. El cobro quedó registrado en
      // VFP, pero decidir qué hacer con ese dinero es de una persona, no del sync.
      if (actual.estado === EstadoPedido.CANCELADO) {
        throw new ConflictException('El pedido se canceló durante el pago');
      }
      // El ADMIN humano solo marca desde PENDIENTE_PAGO; solo el agente puede venir de
      // otro estado no terminal (y ya se verificó arriba que el pedido llegó al ERP).
      if (!esAgente && actual.estado !== EstadoPedido.PENDIENTE_PAGO) {
        throw new ConflictException('El estado del pedido cambió durante el pago');
      }

      const result = await tx.pedido.updateMany({
        where: { id: pedidoId, estado: actual.estado },
        data: {
          estado: EstadoPedido.PAGADO,
          fechaPago,
          cajeroAsignadoId: null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('El estado del pedido cambió durante el pago');
      }
      const pedidoActualizado = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedidoActualizado) throw new NotFoundException('Pedido no encontrado');

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: actual.estado,
          estadoNuevo: EstadoPedido.PAGADO,
          // Un pago a mano debe poder distinguirse a simple vista de un cobro de VFP.
          observacion: esAgente
            ? referencia
              ? `Pago confirmado (ref: ${referencia})`
              : 'Pago confirmado por sistema externo'
            : `Pago confirmado MANUALMENTE por ${usuario.nombre}` +
              (referencia ? ` (ref: ${referencia})` : ' (sin referencia)'),
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      // Los efectos externos se devuelven y se disparan DESPUÉS del commit:
      // emitirlos aquí los mandaría antes de confirmar, y un rollback
      // posterior dejaría a los clientes con un evento de un cambio que nunca
      // ocurrió.
      // Oct 2026: el cobro lo registró una PERSONA en la nube (no vino del Sistema Comercial): si el pedido ya está en el
      // ERP, allá no hay cobro. Se abre la tarea para que el cajero lo registre. Si el cajero ya lo había cobrado
      // en el Sistema Comercial, el agente lo confirma y la tarea se cierra sola (ver `PedidoPagoHandler`).
      if (!esAgente) {
        await reflejarCobroManualEnErp(
          tx,
          pedidoId,
          { id: usuario.userId, rol: usuario.rol, nombre: usuario.nombre },
          referencia ? `Cobro manual (ref: ${referencia})` : 'Cobro manual sin referencia',
        );
      }

      return {
        yaPagado: false as const,
        pedido: pedidoActualizado,
        tiendaId: pedido.tiendaId,
        estadoAnterior: actual.estado,
      };
    });

    // Idempotente: el pedido ya estaba pagado, no se emite nada.
    if (resultado.yaPagado) return resultado.pedido;

    if (!esAgente) {
      this.logger.warn(
        `Pago MANUAL del pedido ${pedidoId} por ${usuario.nombre} (id ${usuario.userId})` +
          (referencia ? ` ref=${referencia}` : ' sin referencia'),
      );
    }

    // `estadoAnterior` sale del pedido REAL (el que se leyó en la transacción), no de un
    // literal: el agente puede llegar desde cualquier estado no-terminal (el cobro ya
    // ocurrió en VFP), así que el evento no debe mentir sobre el origen de la transición.
    const estadoAnterior = resultado.estadoAnterior;
    this.realtime.emitToTienda(resultado.tiendaId, 'pedido.estado', {
      id: pedidoId,
      estadoAnterior,
      estadoNuevo: EstadoPedido.PAGADO,
    });
    this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
      id: pedidoId,
      estadoAnterior,
      estadoNuevo: EstadoPedido.PAGADO,
    });

    // Oct 2026: el pago por transferencia de este pedido (si lo hay) se entera. Va DESPUÉS del
    // commit y con sus errores contenidos: el cobro de VFP ya quedó registrado y no debe
    // deshacerse porque falle el módulo de pagos. Si esto falla, quien mira el pago lo corrige
    // (`sanarSiYaSeCobro`).
    try {
      const cambioPago = await resolverPagoAlCobrarse(
        this.prisma,
        pedidoId,
        esAgente ? ACTOR_AGENTE : { id: usuario.userId, rol: usuario.rol, nombre: usuario.nombre },
      );
      if (cambioPago) emitirCambioDePago(this.realtime, cambioPago);
    } catch (err) {
      this.logger.error(
        `Pedido ${pedidoId} cobrado, pero no se pudo actualizar su pago por transferencia: ${(err as Error).message}`,
      );
    }

    const pedidoCompleto = await this.prisma.pedido.findUnique({ where: { id: pedidoId } });
    if (pedidoCompleto) {
      void this.notifications
        .enviar(pedidoCompleto, TipoNotificacion.PAGO_CONFIRMADO)
        .catch((err) =>
          this.logger.error(`Error enviando notificación PAGO_CONFIRMADO: ${err.message}`),
        );
    }

    return resultado.pedido;
  }
}
