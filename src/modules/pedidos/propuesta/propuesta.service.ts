import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { SurtidoService } from '../bodega/surtido.service';
import { UserContext } from '../../../types/pedido.types';
import {
  EstadoPedido,
  EstadoPropuesta,
  RolUsuario,
  Prisma,
} from '@prisma/client';
import { CrearPropuestaDto, ResponderPropuestaDto } from './dto/propuesta.dto';
import { pausarReloj, reanudarReloj } from '../core/atencion.util';

/**
 * F12 (sep 2026): flujo de propuesta/contrapropuesta entre bodega y cliente.
 *
 * Cuando faltan productos, el bodeguero envía una propuesta de ajuste. El
 * pedido pasa a WAITING_CUSTOMER_APPROVAL y el reloj de atención se PAUSA
 * (la pelota es del cliente). El cliente acepta o rechaza. Solo al ACEPTAR,
 * bodega aplica los cambios y libera a PENDING_PAID. Si rechaza, vuelve a
 * REVIEWING para re-trabajar.
 *
 * La propuesta se ATA AL PEDIDO, no al bodeguero: si el bodeguero la libera
 * a la cola, la propuesta persiste y la respuesta del cliente se aplica al
 * pedido sin importar quién esté asignado.
 */
@Injectable()
export class PropuestaService {
  private readonly logger = new Logger(PropuestaService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeService,
    private access: PedidoAccessService,
    private state: PedidoStateService,
    private surtido: SurtidoService,
  ) {}

  /**
   * Bodega envía una propuesta de ajuste. El pedido debe estar en REVIEWING
   * y asignado al bodeguero (o admin). Transiciona a WAITING_CUSTOMER_APPROVAL
   * y PAUSA el reloj de atención.
   *
   * Si ya existe una propuesta PENDIENTE, se rechaza (no se pueden apilar).
   */
  async enviarPropuesta(
    pedidoId: number,
    dto: CrearPropuestaDto,
    usuario: UserContext,
  ) {
    await this.access.cargarYValidar(pedidoId, usuario, {
      requiereAsignacionBodega: true,
    });

    if (dto.items.length === 0) {
      throw new BadRequestException('La propuesta debe tener al menos un item.');
    }

    return this.prisma.$transaction(async (tx) => {
      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');

      if (pedido.estado !== EstadoPedido.REVIEWING) {
        throw new BadRequestException(
          `Sólo se puede enviar una propuesta en estado REVIEWING (actual: ${pedido.estado})`,
        );
      }

      // No apilar propuestas pendientes.
      const pendiente = await tx.pedidoPropuesta.findFirst({
        where: { pedidoId, estado: EstadoPropuesta.PENDIENTE },
      });
      if (pendiente) {
        throw new ConflictException(
          'Ya existe una propuesta pendiente de respuesta del cliente. Espera a que responda o cancélala.',
        );
      }

      const ahora = new Date();

      const propuesta = await tx.pedidoPropuesta.create({
        data: {
          pedidoId,
          estado: EstadoPropuesta.PENDIENTE,
          items: dto.items as unknown as Prisma.InputJsonValue,
          total: new Prisma.Decimal(dto.total),
          nota: dto.nota ?? null,
          creadaPorId: usuario.userId,
          enviadaAt: ahora,
        },
      });

      // Transicionar a WAITING_CUSTOMER_APPROVAL y pausar el reloj.
      // Mantener asignadoAId: el pedido sigue en "mis pedidos" del bodeguero.
      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          ...pausarReloj(
            {
              tiempoAtencionBodegaMs: pedido.tiempoAtencionBodegaMs,
              bodegaTurnoDesdeAt: pedido.bodegaTurnoDesdeAt,
            },
            ahora,
          ),
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.REVIEWING,
          estadoNuevo: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          observacion: `Propuesta enviada al cliente (${dto.items.length} item(s), total $${dto.total})`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.REVIEWING,
        estadoNuevo: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        asignadoAId: pedido.asignadoAId,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.REVIEWING,
        estadoNuevo: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
      });
      this.realtime.emitToUser(pedido.usuarioId, 'propuesta.enviada', {
        pedidoId,
        propuestaId: propuesta.id,
      });

      this.logger.log(
        `Pedido ${pedidoId}: propuesta #${propuesta.id} enviada → WAITING_CUSTOMER_APPROVAL`,
      );

      return propuesta;
    });
  }

  /**
   * Cliente responde a una propuesta: ACEPTAR o RECHAZAR.
   * - ACEPTAR: la propuesta queda ACEPTADA y el pedido vuelve a REVIEWING.
   *   El bodeguero termina de surtir y confirma (confirmarSurtido), que es
   *   cuando se aplican los cambios y se encola a Firebird (PENDING_PAID).
   *   NO se encola aquí: el pedido aún no está en pendiente de pago.
   * - RECHAZAR: vuelve a REVIEWING (reanuda reloj) para que bodega re-trabaje.
   *
   * Solo el cliente dueño del pedido puede responder.
   */
  async responderPropuesta(
    pedidoId: number,
    propuestaId: number,
    dto: ResponderPropuestaDto,
    usuario: UserContext,
  ) {
    // El cliente debe ser el dueño del pedido.
    await this.access.cargarYValidar(pedidoId, usuario);

    return this.prisma.$transaction(async (tx) => {
      const propuesta = await tx.pedidoPropuesta.findFirst({
        where: { id: propuestaId, pedidoId },
      });
      if (!propuesta) {
        throw new NotFoundException('Propuesta no encontrada');
      }
      if (propuesta.estado !== EstadoPropuesta.PENDIENTE) {
        throw new ConflictException(
          `Esta propuesta ya fue respondida (estado: ${propuesta.estado})`,
        );
      }

      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');
      if (pedido.estado !== EstadoPedido.WAITING_CUSTOMER_APPROVAL) {
        throw new BadRequestException(
          `El pedido no está esperando aprobación (actual: ${pedido.estado})`,
        );
      }

      const ahora = new Date();

      if (dto.decision === 'ACEPTAR') {
        // El cliente acepta: la propuesta queda ACEPTADA y el pedido vuelve a
        // REVIEWING para que el bodeguero termine de surtir y confirme. Los
        // cambios se aplican en confirmarSurtido (no aquí).
        await tx.pedidoPropuesta.update({
          where: { id: propuestaId },
          data: {
            estado: EstadoPropuesta.ACEPTADA,
            respondidaAt: ahora,
            notaCliente: dto.nota ?? null,
          },
        });

        await tx.pedido.update({
          where: { id: pedidoId },
          data: {
            estado: EstadoPedido.REVIEWING,
            // Mantener asignadoAId: el bodeguero que la envió la retoma.
            ...reanudarReloj(
              {
                tiempoAtencionBodegaMs: pedido.tiempoAtencionBodegaMs,
                bodegaTurnoDesdeAt: pedido.bodegaTurnoDesdeAt,
              },
              ahora,
            ),
          },
        });

        await tx.historialPedido.create({
          data: {
            pedidoId,
            estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
            estadoNuevo: EstadoPedido.REVIEWING,
            observacion: `Cliente aceptó la propuesta #${propuestaId}. Bodega puede confirmar el surtido.`,
            usuarioId: usuario.userId,
            usuarioNombre: usuario.nombre,
          },
        });

        this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
          id: pedidoId,
          estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          estadoNuevo: EstadoPedido.REVIEWING,
          asignadoAId: pedido.asignadoAId,
        });
        this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
          id: pedidoId,
          estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          estadoNuevo: EstadoPedido.REVIEWING,
        });

        this.logger.log(
          `Pedido ${pedidoId}: cliente aceptó propuesta #${propuestaId} → REVIEWING (bodega confirma)`,
        );

        return {
          mensaje: 'Propuesta aceptada. El bodeguero puede confirmar el surtido.',
          estado: EstadoPedido.REVIEWING,
          propuestaId,
        };
      }

      // RECHAZAR: volver a REVIEWING, reanudar reloj.
      await tx.pedidoPropuesta.update({
        where: { id: propuestaId },
        data: {
          estado: EstadoPropuesta.RECHAZADA,
          respondidaAt: ahora,
          notaCliente: dto.nota ?? null,
        },
      });

      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.REVIEWING,
          // Mantener asignadoAId: el bodeguero que la envió la retoma.
          ...reanudarReloj(
            {
              tiempoAtencionBodegaMs: pedido.tiempoAtencionBodegaMs,
              bodegaTurnoDesdeAt: pedido.bodegaTurnoDesdeAt,
            },
            ahora,
          ),
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          estadoNuevo: EstadoPedido.REVIEWING,
          observacion: `Cliente rechazó la propuesta #${propuestaId}${dto.nota ? `: ${dto.nota}` : ''}`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        estadoNuevo: EstadoPedido.REVIEWING,
        asignadoAId: pedido.asignadoAId,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        estadoNuevo: EstadoPedido.REVIEWING,
      });

      this.logger.log(
        `Pedido ${pedidoId}: cliente rechazó propuesta #${propuestaId} → REVIEWING`,
      );

      return {
        mensaje: 'Propuesta rechazada. El pedido volvió a revisión.',
        estado: EstadoPedido.REVIEWING,
        propuestaId,
      };
    });
  }

  /**
   * Admin fuerza la aprobación de una propuesta sin respuesta del cliente
   * (caso excepcional: cliente no responde). Registra auditoría.
   */
  async forzarAprobacion(
    pedidoId: number,
    propuestaId: number,
    usuario: UserContext,
  ) {
    if (usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Sólo un admin puede forzar la aprobación.');
    }

    return this.prisma.$transaction(async (tx) => {
      const propuesta = await tx.pedidoPropuesta.findFirst({
        where: { id: propuestaId, pedidoId },
      });
      if (!propuesta) throw new NotFoundException('Propuesta no encontrada');
      if (propuesta.estado !== EstadoPropuesta.PENDIENTE) {
        throw new ConflictException('La propuesta ya fue respondida.');
      }

      const pedido = await tx.pedido.findUnique({ where: { id: pedidoId } });
      if (!pedido) throw new NotFoundException('Pedido no encontrado');
      if (pedido.estado !== EstadoPedido.WAITING_CUSTOMER_APPROVAL) {
        throw new BadRequestException(
          `El pedido no está esperando aprobación (actual: ${pedido.estado})`,
        );
      }

      const ahora = new Date();

      // El admin fuerza la aprobación: la propuesta queda ACEPTADA y el pedido
      // vuelve a REVIEWING para que el bodeguero confirme el surtido. Los
      // cambios se aplican en confirmarSurtido (no aquí). No se encola a
      // Firebird hasta que el pedido pase a PENDING_PAID.
      await tx.pedidoPropuesta.update({
        where: { id: propuestaId },
        data: {
          estado: EstadoPropuesta.ACEPTADA,
          respondidaAt: ahora,
          forzadaPorId: usuario.userId,
          forzadaAt: ahora,
        },
      });

      await tx.pedido.update({
        where: { id: pedidoId },
        data: {
          estado: EstadoPedido.REVIEWING,
          ...reanudarReloj(
            {
              tiempoAtencionBodegaMs: pedido.tiempoAtencionBodegaMs,
              bodegaTurnoDesdeAt: pedido.bodegaTurnoDesdeAt,
            },
            ahora,
          ),
        },
      });

      await tx.historialPedido.create({
        data: {
          pedidoId,
          estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
          estadoNuevo: EstadoPedido.REVIEWING,
          observacion: `Aprobación forzada por admin (${usuario.nombre}) sin respuesta del cliente. Bodega puede confirmar el surtido.`,
          usuarioId: usuario.userId,
          usuarioNombre: usuario.nombre,
        },
      });

      this.realtime.emitToTienda(pedido.tiendaId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        estadoNuevo: EstadoPedido.REVIEWING,
        asignadoAId: pedido.asignadoAId,
      });
      this.realtime.emitToPedido(pedidoId, 'pedido.estado', {
        id: pedidoId,
        estadoAnterior: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
        estadoNuevo: EstadoPedido.REVIEWING,
      });

      this.logger.log(
        `Pedido ${pedidoId}: aprobación forzada por admin ${usuario.nombre} (propuesta #${propuestaId}) → REVIEWING`,
      );

      return {
        mensaje: 'Aprobación forzada. El bodeguero puede confirmar el surtido.',
        estado: EstadoPedido.REVIEWING,
        propuestaId,
      };
    });
  }

  /**
   * Lista las propuestas de un pedido (para el historial y la UI).
   */
  async listarPropuestas(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.prisma.pedidoPropuesta.findMany({
      where: { pedidoId },
      orderBy: { enviadaAt: 'asc' },
      include: {
        creadaPor: { select: { id: true, nombre: true, apellido: true } },
        forzadaPor: { select: { id: true, nombre: true, apellido: true } },
      },
    });
  }
}
