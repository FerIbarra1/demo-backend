import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RolUsuario, TipoNotificacion } from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { CrearMensajeDto } from './dto/mensaje.dto';
import { PedidoAccessService } from '../core/pedido-access.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { MailService } from '../../mail/mail.service';
import { mailTemplates, mailSubjects } from '../../mail/mail.templates';

const ROLES_PUEDEN_INTERNO: RolUsuario[] = [
  RolUsuario.BODEGA,
  RolUsuario.CAJERO,
  RolUsuario.ADMIN,
];

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private prisma: PrismaService,
    private access: PedidoAccessService,
    private realtime: RealtimeService,
    private mail: MailService,
    private config: ConfigService,
  ) {}

  /**
   * Crea un mensaje en un pedido, anclado opcionalmente a un item.
   *
   * Autorización (sólo pueden escribir):
   *   - CLIENTE: sólo en SUS pedidos (dueño).
   *   - BODEGA: sólo si está ASIGNADO al pedido (asignadoAId === userId).
   *   - ADMIN: pasa siempre.
   *   - BODEGA_MONITOR, CAJERO: no pueden escribir. Sólo leen.
   *
   * - visibleParaCliente=true: el cliente lo ve (default).
   * - visibleParaCliente=false: anotación interna. Sólo BODEGA/CAJERO/ADMIN.
   *
   * Si viene itemId, valida que el item pertenezca al mismo pedido.
   *
   * Emite `mensaje.creado` por WS al room `pedido-{id}` y a `user-{clienteId}`
   * (cuando es visible al cliente) para que llegue en tiempo real.
   */
  async crear(pedidoId: number, dto: CrearMensajeDto, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const esBodeguero = usuario.rol === RolUsuario.BODEGA;
    const esAdmin = usuario.rol === RolUsuario.ADMIN;
    const esAsignado = esBodeguero && pedido.asignadoAId === usuario.userId;

    if (!esCliente && !esAsignado && !esAdmin) {
      throw new BadRequestException(
        'Sólo el cliente dueño del pedido o el bodeguero asignado pueden escribir mensajes. ' +
          'BODEGA_MONITOR y CAJERO tienen acceso de sólo lectura.',
      );
    }

    const quiereInterno = dto.visibleParaCliente === false;
    if (quiereInterno && !ROLES_PUEDEN_INTERNO.includes(usuario.rol)) {
      throw new BadRequestException(
        'Sólo BODEGA, CAJERO o ADMIN pueden crear mensajes no visibles al cliente',
      );
    }

    // Si viene itemId, validar que pertenezca al pedido (defensa contra
    // payloads que intenten anclar mensajes a items de otros pedidos).
    if (dto.itemId != null) {
      const item = await this.prisma.itemPedido.findUnique({
        where: { id: dto.itemId },
        select: { pedidoId: true },
      });
      if (!item || item.pedidoId !== pedidoId) {
        throw new BadRequestException(
          `Item ${dto.itemId} no pertenece al pedido ${pedidoId}`,
        );
      }
    }

    const mensaje = await this.prisma.pedidoMensaje.create({
      data: {
        pedidoId,
        itemId: dto.itemId ?? null,
        autorId: usuario.userId,
        autorRol: usuario.rol,
        contenido: dto.contenido,
        visibleParaCliente: !quiereInterno,
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    // Realtime: notificar al room del pedido (bodegueros, monitor) y, si el
    // mensaje es visible al cliente, también al cliente directamente.
    const payload = {
      id: mensaje.id,
      pedidoId,
      itemId: mensaje.itemId,
      autorId: mensaje.autorId,
      autorNombre: mensaje.autor.nombre,
      autorRol: mensaje.autorRol,
      contenido: mensaje.contenido,
      visibleParaCliente: mensaje.visibleParaCliente,
      createdAt: mensaje.createdAt.toISOString(),
    };
    this.realtime.emitToPedido(pedidoId, 'mensaje.creado', payload);
    if (mensaje.visibleParaCliente) {
      this.realtime.emitToUser(pedido.usuarioId, 'mensaje.creado', payload);
    }

    // Email al cliente: PRIMERA respuesta visible del bodeguero en este
    // pedido. Se marca con un flag (MensajeBodegueroEnviado) para que sólo
    // se mande UNA vez por pedido — los siguientes mensajes del bodeguero
    // llegan al cliente por realtime dentro de la app sin saturar el buzón.
    if (mensaje.autorRol === RolUsuario.BODEGA && mensaje.visibleParaCliente) {
      // Checar el flag fuera de la transacción para no bloquear el create
      // del mensaje en caso de carga. La creación del flag sí va en
      // transacción (best-effort) para que no se manden duplicados si
      // dos mensajes del bodeguero entran casi simultáneos.
      const yaEnviado = await this.prisma.mensajeBodegueroEnviado.findUnique({
        where: { pedidoId },
      });
      if (!yaEnviado) {
        this.dispararEmailPrimeraRespuestaBodeguero(mensaje.id, pedidoId).catch(
          (err) =>
            this.logger.error(
              `Falló email MENSAJE_BODEGUERO (pedido ${pedidoId}): ${err.message}`,
            ),
        );
      }
    }

    return mensaje;
  }

  /**
   * Crea el flag `MensajeBodegueroEnviado` y dispara el email al cliente.
   * El flag se crea en transacción best-effort: si dos mensajes del
   * bodeguero se cuelan al mismo tiempo, el segundo se entera (unique
   * constraint en pedidoId) y se aborta el envío duplicado.
   */
  private async dispararEmailPrimeraRespuestaBodeguero(
    mensajeId: number,
    pedidoId: number,
  ) {
    // Cargamos el pedido completo con la info que necesita la plantilla.
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { tienda: true },
    });
    if (!pedido?.clienteEmail) return;
    const mensaje = await this.prisma.pedidoMensaje.findUnique({
      where: { id: mensajeId },
      include: { autor: { select: { nombre: true, apellido: true } } },
    });
    if (!mensaje) return;

    const logoUrl = this.config.get<string>('app.mail.logoUrl') ?? '';
    const frontendUrl = this.config.get<string>('app.mail.frontendUrl') ?? '';
    const pedidoUrl = `${frontendUrl}/pedidos/${pedido.id}`;

    const nombreBodeguero = `${mensaje.autor.nombre ?? ''} ${mensaje.autor.apellido ?? ''}`.trim();

    // Marcamos el flag ANTES de enviar. Si falla la creación (caso
    // concurrente con otro mensaje del bodeguero), abortamos.
    try {
      await this.prisma.mensajeBodegueroEnviado.create({
        data: { pedidoId, mensajeId },
      });
    } catch (err: any) {
      // P2002 = unique constraint. Otro hilo ya creó el flag: no enviar.
      this.logger.log(
        `Pedido ${pedidoId}: flag de primera respuesta ya existía, no se envía email duplicado`,
      );
      return;
    }

    const template = mailTemplates.MensajeBodeguero({
      pedido: {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        total: pedido.total,
        fechaPedido: pedido.fechaPedido,
        tiendaNombre: pedido.tienda?.nombre,
      },
      pedidoUrl,
      mensaje: mensaje.contenido,
      nombreBodeguero: nombreBodeguero || 'El bodeguero',
      logoUrl,
      frontendUrl,
    });

    await this.mail.sendEmail({
      to: pedido.clienteEmail,
      subject: mailSubjects.MENSAJE_BODEGUERO(pedido.numeroPedido),
      template,
      tipoNotificacion: TipoNotificacion.MENSAJE_BODEGUERO,
      pedidoId: pedido.id,
    });
  }

  /**
   * Lista mensajes del pedido respetando el rol:
   * - CLIENTE: sólo visibleParaCliente=true y sólo de SUS pedidos.
   * - BODEGA, CAJERO, ADMIN, BODEGA_MONITOR: todos los mensajes internos
   *   sólo si el pedido es de su tienda.
   */
  async listar(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);

    const where: any = { pedidoId };
    if (usuario.rol === RolUsuario.CLIENTE) {
      where.visibleParaCliente = true;
    }

    return this.prisma.pedidoMensaje.findMany({
      where,
      include: {
        autor: { select: { id: true, nombre: true, rol: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}