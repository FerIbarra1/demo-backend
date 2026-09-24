import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RolUsuario, TipoNotificacion } from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { CrearMensajeDto, CrearMensajeConAdjuntoDto, MarcarLeidoDto } from './dto/mensaje.dto';
import { PropuestaService } from '../propuesta/propuesta.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { MailService } from '../../mail/mail.service';
import { ConfiguracionService } from '../../configuracion/configuracion.service';
import { mailTemplates, mailSubjects } from '../../mail/mail.templates';

/**
 * F13 (sep 2026): el chat con el cliente es del ASESOR DE VENTAS. El bodeguero
 * perdió el acceso por completo (ni lee ni escribe) — su trabajo es verificar
 * existencia, no negociar. CAJERO se mantiene para notas internas de ventanilla.
 */
const ROLES_PUEDEN_INTERNO: RolUsuario[] = [
  RolUsuario.VENTAS,
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
    private propuesta: PropuestaService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  /**
   * Crea un mensaje en un pedido, anclado opcionalmente a un item.
   *
   * Autorización (sólo pueden escribir):
   *   - CLIENTE: sólo en SUS pedidos (dueño).
   *   - VENTAS: cualquier pedido de su tienda (F13: el asesor atiende la cola
   *     de escalados de la tienda, sin asignación 1:1).
   *   - ADMIN: pasa siempre.
   *   - BODEGA, BODEGA_MONITOR, CAJERO, MOSTRADOR: no pueden escribir. F13 le
   *     quitó el chat al bodeguero por completo (antes podía si estaba
   *     asignado).
   *
   * - visibleParaCliente=true: el cliente lo ve (default).
   * - visibleParaCliente=false: anotación interna. Sólo VENTAS/CAJERO/ADMIN.
   *
   * Si viene itemId, valida que el item pertenezca al mismo pedido.
   *
   * Emite `mensaje.creado` por WS al room `pedido-{id}` y a `user-{clienteId}`
   * (cuando es visible al cliente) para que llegue en tiempo real.
   */
  async crear(pedidoId: number, dto: CrearMensajeDto, usuario: UserContext) {
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const esVentas = usuario.rol === RolUsuario.VENTAS;
    const esAdmin = usuario.rol === RolUsuario.ADMIN;

    if (!esCliente && !esVentas && !esAdmin) {
      throw new BadRequestException(
        'Sólo el cliente dueño del pedido o el asesor de ventas pueden escribir mensajes. ' +
          'Bodega, monitores y cajero tienen acceso de sólo lectura.',
      );
    }

    const quiereInterno = dto.visibleParaCliente === false;
    if (quiereInterno && !ROLES_PUEDEN_INTERNO.includes(usuario.rol)) {
      throw new BadRequestException(
        'Sólo VENTAS, CAJERO o ADMIN pueden crear mensajes no visibles al cliente',
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

    // Email al cliente: PRIMERA respuesta visible del asesor en este pedido.
    // Se marca con un flag (MensajeBodegueroEnviado) para que sólo se mande
    // UNA vez por pedido — los siguientes mensajes llegan al cliente por
    // realtime dentro de la app sin saturar el buzón.
    //
    // F13: el trigger pasó de BODEGA a VENTAS (el chat cambió de dueño). El
    // modelo conserva su nombre histórico por compatibilidad de tabla.
    if (mensaje.autorRol === RolUsuario.VENTAS && mensaje.visibleParaCliente) {
      const yaEnviado = await this.prisma.mensajeBodegueroEnviado.findUnique({
        where: { pedidoId },
      });
      if (!yaEnviado) {
        this.dispararEmailPrimeraRespuestaAsesor(mensaje.id, pedidoId).catch(
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
   * El flag se crea en transacción best-effort: si dos mensajes del asesor se
   * cuelan al mismo tiempo, el segundo se entera (unique constraint en
   * pedidoId) y se aborta el envío duplicado.
   */
  private async dispararEmailPrimeraRespuestaAsesor(
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

    const logoUrl = await this.configuracion.obtenerLogoUrl();
    const frontendUrl = this.config.get<string>('app.mail.frontendUrl') ?? '';
    const pedidoUrl = `${frontendUrl}/pedidos/${pedido.id}`;

    const nombreAsesor = `${mensaje.autor.nombre ?? ''} ${mensaje.autor.apellido ?? ''}`.trim();

    // Marcamos el flag ANTES de enviar. Si falla la creación (caso
    // concurrente con otro mensaje del asesor), abortamos.
    try {
      await this.prisma.mensajeBodegueroEnviado.create({
        data: { pedidoId, mensajeId },
      });
    } catch {
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
      nombreBodeguero: nombreAsesor || 'Tu asesor de ventas',
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

    const mensajes = await this.prisma.pedidoMensaje.findMany({
      where,
      include: {
        autor: { select: { id: true, nombre: true, rol: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // F14: el frontend lee `autorNombre` plano (igual que el payload del
    // evento `mensaje.creado`). Sin este aplanado las burbujas renderizaban
    // "undefined (VENTAS)". Se conserva `autor` anidado por compatibilidad.
    return mensajes.map((m) => ({ ...m, autorNombre: m.autor.nombre }));
  }


  /**
   * F13 (sep 2026): crea un mensaje de chat que opcionalmente adjunta una
   * propuesta (estilo WhatsApp/Airbnb). Si `dto.propuestaItems` está presente,
   * se crea la `PedidoPropuesta` y el `PedidoMensaje` con `adjunto` en la misma
   * transacción — el cliente ve texto + propuesta como una unidad, y desde el
   * mismo mensaje aprueba / rechaza / contacta al vendedor.
   *
   * Si no hay propuesta, equivale a `crear` con un campo extra (`adjunto: null`).
   *
   * El campo `PedidoPropuesta.items` se guarda como snapshot — sigue siendo la
   * fuente de verdad de la decisión del cliente.
   */
  async crearConAdjunto(
    pedidoId: number,
    dto: CrearMensajeConAdjuntoDto,
    usuario: UserContext,
  ) {
    // 1. Validaciones de acceso y estado (igual que `crear`).
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const esVentas = usuario.rol === RolUsuario.VENTAS;
    const esBodega = usuario.rol === RolUsuario.BODEGA;
    const esAdmin = usuario.rol === RolUsuario.ADMIN;

    // F14 (sep 2026): bodega también puede enviar propuestas con adjunto.
    // El flujo es: bodeguero marca "No hay"/"Hay menos" en el surtido, arma
    // la propuesta, y la manda como un solo mensaje-con-adjunto al cliente.
    // Sin esto, la propuesta se creaba en BD pero el cliente no veía nada en
    // el chat (sólo el badge "Esperando tu aprobación" sin propuesta visible).
    if (!esCliente && !esVentas && !esBodega && !esAdmin) {
      throw new BadRequestException(
        'Sólo el cliente dueño del pedido, bodega, el asesor de ventas o ' +
          'admin pueden escribir mensajes con adjunto. Monitores y cajero ' +
          'tienen acceso de sólo lectura.',
      );
    }

    // 2. Si trae propuesta, validarla primero (delegamos al service de
    // propuestas para no duplicar reglas: el origen del caller determina qué
    // decisiones legales tiene el cliente).
    let adjunto: { tipo: 'propuesta'; propuestaId: number } | null = null;
    if (dto.propuestaItems && dto.propuestaItems.length > 0) {
      // El service de propuestas hace todas las validaciones; nosotros sólo
      // creamos el `PedidoMensaje` con el id resultante en la misma tx.
      const propuesta = await this.propuesta.enviarPropuesta(
        pedidoId,
        {
          items: dto.propuestaItems.map((it) => ({
            itemId: it.itemId,
            tipo: it.tipo,
            producto: it.producto,
            variante: it.variante,
            // El snapshot es la fuente de verdad de lo que el cliente ve en la
            // tarjeta del chat, así que se guarda el item COMPLETO: la imagen,
            // el productoId (para resolver la foto de un `agregado`) y el
            // "antes" de los tipos `cambio`/`parcial`. Antes este map los
            // descartaba y la tarjeta no podía mostrar ni la foto ni el delta.
            productoImagen: it.productoImagen ?? null,
            cantidad: it.cantidad,
            precioUnitario: it.precioUnitario,
            subtotal: it.subtotal,
            productoOriginal: it.productoOriginal ?? null,
            varianteOriginal: it.varianteOriginal ?? null,
            cantidadOriginal: it.cantidadOriginal ?? null,
            productoNuevo: it.productoNuevo ?? null,
            varianteNueva: it.varianteNueva ?? null,
            cantidadNueva: it.cantidadNueva ?? null,
            precioUnitarioNuevo: it.precioUnitarioNuevo ?? null,
            subtotalNuevo: it.subtotalNuevo ?? null,
            tempId: it.tempId ?? null,
            productoId: it.productoId ?? null,
            precioCOId: it.precioCOId ?? null,
          })),
          total: dto.total ?? 0,
          // El texto del mensaje YA es el "comentario" de la propuesta; no
          // necesitamos un campo `nota` separado en la propuesta.
        } as any,
        usuario,
      );
      adjunto = { tipo: 'propuesta', propuestaId: propuesta.id };
    }

    // 3. Crear el mensaje con el adjunto.
    const mensaje = await this.prisma.pedidoMensaje.create({
      data: {
        pedidoId,
        itemId: null,
        autorId: usuario.userId,
        autorRol: usuario.rol,
        contenido: dto.contenido,
        visibleParaCliente: true, // el nuevo endpoint siempre es visible al cliente
        adjunto: adjunto ?? undefined,
      },
      include: { autor: { select: { id: true, nombre: true, rol: true } } },
    });

    // 4. Realtime: el cliente y el room del pedido reciben el mensaje con su
    // `adjunto` para que el chat sepa qué renderizar.
    const payload: Record<string, unknown> = {
      id: mensaje.id,
      pedidoId,
      itemId: mensaje.itemId,
      autorId: mensaje.autorId,
      autorNombre: mensaje.autor.nombre,
      autorRol: mensaje.autorRol,
      contenido: mensaje.contenido,
      visibleParaCliente: mensaje.visibleParaCliente,
      createdAt: mensaje.createdAt.toISOString(),
      adjunto: adjunto,
    };
    this.realtime.emitToPedido(pedidoId, 'mensaje.creado', payload);
    this.realtime.emitToUser(pedido.usuarioId, 'mensaje.creado', payload);

    // 5. Si el vendedor mandó su primer mensaje visible al cliente, mandar
    // el email "tu asesor te contactó" (igual que en `crear`).
    if (mensaje.autorRol === RolUsuario.VENTAS) {
      const yaEnviado = await this.prisma.mensajeBodegueroEnviado.findUnique({
        where: { pedidoId },
      });
      if (!yaEnviado) {
        this.dispararEmailPrimeraRespuestaAsesor(mensaje.id, pedidoId).catch(
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
   * F15 (sep 2026): marca de agua de lectura del chat (modelo WhatsApp/Telegram).
   *
   * El caller puede ser:
   *   - CLIENTE → bumpea `cliente_ultimo_mensaje_leido_id` y opcionalmente
   *     `cliente_ultimo_mensaje_entregado_id` (cuando recibe el eco del socket).
   *   - VENTAS / BODEGA_MONITOR / CAJERO / ADMIN → bumpea `tienda_ultimo_mensaje_leido_id`.
   *     El watermark es por LADO, no por usuario (1 asesor por tienda).
   *
   * Idempotente: nunca decrementa. Si el id actual ya es >= nuevo, no hace
   * nada. La transición se hace con `updateMany` y un guard OR en `where` para
   * evitar el clásico read-modify-write race entre dos pestañas abiertas.
   *
   * Después de bumpear, emite `mensaje.leido` al room del pedido y al cliente
   * para que el otro lado vea los ticks ✓✓ actualizarse en tiempo real.
   */
  async marcarLeido(
    pedidoId: number,
    dto: MarcarLeidoDto,
    usuario: UserContext,
  ) {
    await this.access.cargarYValidar(pedidoId, usuario);

    // El id del último mensaje que el caller vio. Si el caller pide bumpear
    // un id mayor al último mensaje real, lo clampeamos para no aceptar
    // ids bogus (defensa contra payloads manipulados).
    const maxId = await this.prisma.pedidoMensaje.aggregate({
      where: { pedidoId },
      _max: { id: true },
    });
    const ultimoId = Math.min(
      dto.ultimoMensajeId,
      maxId._max.id ?? dto.ultimoMensajeId,
    );

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const campoLeido = esCliente
      ? 'clienteUltimoMensajeLeidoId'
      : 'tiendaUltimoMensajeLeidoId';
    const campoEntregado = 'clienteUltimoMensajeEntregadoId';

    // 1. Avance del watermark del LADO del caller (idempotente).
    await this.prisma.pedido.updateMany({
      where: {
        id: pedidoId,
        OR: [{ [campoLeido]: null }, { [campoLeido]: { lt: ultimoId } }],
      },
      data: { [campoLeido]: ultimoId },
    });

    // 2. Si el cliente marcó leído, garantizamos que el watermark de
    // entregado al menos refleje ese id (un leído implica entregado).
    if (esCliente) {
      const pedidoAntes = await this.prisma.pedido.findUnique({
        where: { id: pedidoId },
        select: { clienteUltimoMensajeEntregadoId: true },
      });
      const entregadoActual = pedidoAntes?.clienteUltimoMensajeEntregadoId ?? null;
      // Si pidió bumpear entregado explícitamente O si el leído supera al
      // entregado actual, avanzamos. El leído siempre implica entregado.
      const debeAvanzarEntregado =
        dto.entregado ||
        entregadoActual == null ||
        ultimoId > entregadoActual;
      if (debeAvanzarEntregado) {
        await this.prisma.pedido.updateMany({
          where: {
            id: pedidoId,
            OR: [
              { [campoEntregado]: null },
              { [campoEntregado]: { lt: ultimoId } },
            ],
          },
          data: { [campoEntregado]: ultimoId },
        });
      }
    }

    // 3. Releer el estado final para emitir el evento con los watermarks reales.
    const pedidoFinal = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        usuarioId: true,
        clienteUltimoMensajeLeidoId: true,
        clienteUltimoMensajeEntregadoId: true,
        tiendaUltimoMensajeLeidoId: true,
      },
    });
    if (!pedidoFinal) {
      // No debería pasar porque cargarYValidar ya validó el pedido, pero por
      // seguridad no devolvemos un 500 silencioso.
      return { ok: true };
    }

    const payload = {
      pedidoId,
      lado: esCliente ? ('cliente' as const) : ('tienda' as const),
      clienteUltimoMensajeLeidoId: pedidoFinal.clienteUltimoMensajeLeidoId,
      clienteUltimoMensajeEntregadoId: pedidoFinal.clienteUltimoMensajeEntregadoId,
      tiendaUltimoMensajeLeidoId: pedidoFinal.tiendaUltimoMensajeLeidoId,
    };

    // 4. Realtime: notificar al room del pedido y al cliente para que vea
    // sus ticks actualizarse en tiempo real.
    this.realtime.emitToPedido(pedidoId, 'mensaje.leido', payload);
    this.realtime.emitToUser(pedidoFinal.usuarioId, 'mensaje.leido', payload);

    return payload;
  }
}
