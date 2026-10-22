import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RolUsuario, TipoNotificacion } from '@prisma/client';
import { UserContext } from '../../../types/pedido.types';
import { CrearMensajeDto, CrearMensajeConAdjuntoDto, MarcarLeidoDto } from './dto/mensaje.dto';
import { PropuestaService } from '../propuesta/propuesta.service';
import { AjusteService } from '../propuesta/ajuste.service';
import { PedidoAccessService } from '../core/pedido-access.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { MailService } from '../../mail/mail.service';
import { ConfiguracionService } from '../../configuracion/configuracion.service';
import { mailTemplates, mailSubjects, folioVisible } from '../../mail/mail.templates';
import { referenciaWebDelPrimerCorreo } from '../../mail/referencia-web';

/**
 * F13 (sep 2026): el chat con el cliente es del ASESOR DE VENTAS. El bodeguero
 * perdió el acceso por completo (ni lee ni escribe) — su trabajo es verificar
 * existencia, no negociar. CAJERO se mantiene para notas internas de ventanilla.
 */
const ROLES_PUEDEN_INTERNO: RolUsuario[] = [RolUsuario.VENTAS, RolUsuario.CAJERO, RolUsuario.ADMIN];

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
    /**
     * Oct 2026: para disparar los efectos de la transición que `enviarPropuesta`
     * deja pendientes cuando corre dentro de nuestra transacción. Ver el
     * comentario de `dispararEfectosDeTransicion`.
     */
    private state: PedidoStateService,
    /** Fase 2: arma la contrapropuesta del asesor a partir de su intención. */
    private ajuste: AjusteService,
  ) {}

  /**
   * Crea un mensaje en un pedido, anclado opcionalmente a un item.
   *
   * Autorización (solo pueden escribir):
   *   - CLIENTE: solo en SUS pedidos (dueño).
   *   - VENTAS: cualquier pedido de su tienda (F13: el asesor atiende la cola
   *     de escalados de la tienda, sin asignación 1:1).
   *   - ADMIN: pasa siempre.
   *   - BODEGA, BODEGA_MONITOR, CAJERO, MOSTRADOR: no pueden escribir. F13 le
   *     quitó el chat al bodeguero por completo (antes podía si estaba
   *     asignado).
   *
   * - visibleParaCliente=true: el cliente lo ve (default).
   * - visibleParaCliente=false: anotación interna. Solo VENTAS/CAJERO/ADMIN.
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
        'Solo el cliente dueño del pedido o el asesor de ventas pueden escribir mensajes. ' +
          'Bodega, monitores y cajero tienen acceso de solo lectura.',
      );
    }

    const quiereInterno = dto.visibleParaCliente === false;
    if (quiereInterno && !ROLES_PUEDEN_INTERNO.includes(usuario.rol)) {
      throw new BadRequestException(
        'Solo VENTAS, CAJERO o ADMIN pueden crear mensajes no visibles al cliente',
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
        throw new BadRequestException(`Item ${dto.itemId} no pertenece al pedido ${pedidoId}`);
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
    // Se marca con un flag (MensajeBodegueroEnviado) para que solo se mande
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
        this.dispararEmailPrimeraRespuestaAsesor(mensaje.id, pedidoId).catch((err) =>
          this.logger.error(`Falló email MENSAJE_BODEGUERO (pedido ${pedidoId}): ${err.message}`),
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
  private async dispararEmailPrimeraRespuestaAsesor(mensajeId: number, pedidoId: number) {
    // Cargamos el pedido completo con la info que necesita la plantilla.
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { tienda: true, pendienteEnvio: { select: { externalFolio: true } } },
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
    } catch (err) {
      // Solo P2002 (unique constraint) significa "otro hilo ya creó el flag".
      // Cualquier otro fallo —BD caída, timeout, conexión perdida— NO debe
      // tragarse: antes este catch era ciego, así que un error de
      // infraestructura devolvía en silencio y el cliente nunca recibía el
      // correo "tu asesor te contactó", sin log y sin rastro.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      this.logger.log(
        `Pedido ${pedidoId}: flag de primera respuesta ya existía, no se envía email duplicado`,
      );
      return;
    }

    // El asesor solo escribe con el pedido ya surtido (EN_ASESORIA), o sea cuando el folio del Sistema Comercial ya
    // existe: el correo tiene que llamarlo como lo llama la pantalla y el ticket. Antes el asunto y el cuerpo llevaban el
    // `PD-…` (sin los datos del folio), y el cliente recibía un número que su pedido ya no mostraba.
    const pedidoData = {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      referenciaWeb: await referenciaWebDelPrimerCorreo(this.prisma, pedido),
      externalFolio: pedido.pendienteEnvio?.externalFolio ?? null,
      folioErp: pedido.folioErp ?? null,
      serieTienda: pedido.tienda?.serie ?? null,
      clienteNombre: pedido.clienteNombre,
      estado: pedido.estado,
      total: pedido.total,
      fechaPedido: pedido.fechaPedido,
      tiendaNombre: pedido.tienda?.nombre,
    };
    const template = mailTemplates.MensajeBodeguero({
      pedido: pedidoData,
      pedidoUrl,
      mensaje: mensaje.contenido,
      nombreBodeguero: nombreAsesor || 'Tu asesor de ventas',
      logoUrl,
      frontendUrl,
    });

    await this.mail.sendEmail({
      to: pedido.clienteEmail,
      subject: mailSubjects.MENSAJE_BODEGUERO(folioVisible(pedidoData)),
      template,
      tipoNotificacion: TipoNotificacion.MENSAJE_BODEGUERO,
      pedidoId: pedido.id,
    });
  }

  /**
   * Lista mensajes del pedido respetando el rol:
   * - CLIENTE: solo visibleParaCliente=true y solo de SUS pedidos.
   * - BODEGA, CAJERO, ADMIN, BODEGA_MONITOR: todos los mensajes internos
   *   solo si el pedido es de su tienda.
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
  async crearConAdjunto(pedidoId: number, dto: CrearMensajeConAdjuntoDto, usuario: UserContext) {
    // 1. Validaciones de acceso y estado (igual que `crear`).
    const pedido = await this.access.cargarYValidar(pedidoId, usuario);

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const esVentas = usuario.rol === RolUsuario.VENTAS;
    const esAdmin = usuario.rol === RolUsuario.ADMIN;

    // Oct 2026: BODEGA sale de la lista. F14 le había abierto este endpoint
    // para que mandara su propuesta al cliente desde el surtido, pero F17 lo
    // hizo innecesario: el servidor arma la propuesta de bodega solo, al cerrar
    // el surtido (`core/propuesta-bodega.util.ts`), sin pasar por el chat.
    //
    // Era una inconsistencia viva: `crear` (arriba) ya prohibía a bodega
    // escribir, y CLAUDE.md dice que desde F13 bodega no lee ni escribe el
    // chat. Solo este endpoint lo dejaba pasar. Verificado: el frontend no lo
    // llama desde ninguna vista de bodega.
    if (!esCliente && !esVentas && !esAdmin) {
      throw new BadRequestException(
        'Solo el cliente dueño del pedido, el asesor de ventas o admin pueden ' +
          'escribir mensajes con adjunto. Bodega, monitores y cajero tienen ' +
          'acceso de solo lectura.',
      );
    }

    // 2. Si trae propuesta, validarla primero (delegamos al service de
    // propuestas para no duplicar reglas: el origen del caller determina qué
    // decisiones legales tiene el cliente).
    //
    // Todo lo que sigue corre dentro de UNA transacción: la propuesta, la
    // transición a ESPERANDO_APROBACION y el mensaje de chat que la
    // muestra. El comentario de este método prometía esa atomicidad desde
    // F13, pero no la había: `enviarPropuesta` confirmaba su propia
    // transacción y el mensaje se creaba después, fuera de cualquiera. Si el
    // segundo create fallaba, el cliente quedaba con una propuesta pendiente
    // que no podía ver ni responder — justo el bug que se decía haber
    // arreglado.
    const { mensaje, adjunto, efectosTransicion, propuestaEnviada } =
      await this.prisma.$transaction(async (tx) => {
        let adjunto: { tipo: 'propuesta'; propuestaId: number } | null = null;
        let propuestaEnviada: { pedidoId: number; propuestaId: number; origen: RolUsuario } | null =
          null;
        // Efectos de la transición a ESPERANDO_APROBACION (realtime + correo).
        // `enviarPropuesta` no puede dispararlos cuando corre dentro de esta tx:
        // todavía no confirmó. Los emitimos nosotros después del commit.
        let efectosTransicion:
          | Parameters<PedidoStateService['dispararEfectosDeTransicion']>[1]
          | null = null;

        if (dto.ajuste && dto.ajuste.length > 0) {
          // Fase 2: el servidor arma la propuesta a partir de la INTENCIÓN del
          // asesor, DENTRO de esta transacción (lee el mismo estado de items que
          // guarda). `enviarPropuesta` hace las validaciones de rol y de estado;
          // nosotros solo creamos el `PedidoMensaje` con el id resultante.
          const calculo = await this.ajuste.calcular(pedidoId, dto.ajuste, tx);
          const {
            propuesta,
            efectos,
            propuestaEnviada: avisoPropuesta,
          } = await this.propuesta.enviarPropuesta(
            pedidoId,
            // El texto del mensaje YA es el "comentario" de la propuesta; no
            // necesitamos un campo `nota` separado en la propuesta.
            { calculo },
            usuario,
            tx,
          );
          adjunto = { tipo: 'propuesta', propuestaId: propuesta.id };
          efectosTransicion = efectos;
          propuestaEnviada = avisoPropuesta;
        }

        // Oct 2026: si trae propuesta pero el texto viene vacío, usar uno por
        // defecto. Sin esto el chat muestra una burbuja vacía que parece un error.
        const contenidoFinal =
          dto.contenido && dto.contenido.trim()
            ? dto.contenido
            : adjunto
              ? 'Te envío una nueva propuesta'
              : dto.contenido;

        // 3. Crear el mensaje con el adjunto, en la misma transacción.
        const mensaje = await tx.pedidoMensaje.create({
          data: {
            pedidoId,
            itemId: null,
            autorId: usuario.userId,
            autorRol: usuario.rol,
            contenido: contenidoFinal,
            visibleParaCliente: true, // el nuevo endpoint siempre es visible al cliente
            adjunto: adjunto ?? undefined,
          },
          include: { autor: { select: { id: true, nombre: true, rol: true } } },
        });

        return { mensaje, adjunto, efectosTransicion, propuestaEnviada };
      });

    // Oct 2026: disparar los efectos de la transición, AHORA que la transacción
    // confirmó. Es el contrato que `cambiarEstado` documenta para los callers
    // que pasan `opts.tx`, y que este método no cumplía: la contrapropuesta del
    // asesor movía el pedido a ESPERANDO_APROBACION y el cliente NUNCA recibía
    // el correo `REVISION_PROPUESTA`, porque el efecto se quedaba en el objeto
    // de retorno. El realtime sí llegaba (lo emite este método más abajo), así
    // que el bug era invisible desde la app.
    if (efectosTransicion) {
      this.state.dispararEfectosDeTransicion(pedidoId, efectosTransicion);
    }

    /**
     * F21 (oct 2026): el aviso `propuesta.enviada`, AHORA que la transacción
     * confirmó.
     *
     * Antes lo emitía `PropuestaService` dentro de su propio flujo, pero con
     * `txExterna` eso ocurría ANTES de este commit: si el `pedidoMensaje.create`
     * de arriba fallaba, el rollback deshacía la propuesta pero el cliente ya
     * tenía el aviso de una propuesta inexistente. Es el mismo contrato que los
     * demás efectos externos — se emiten cuando el dato ya es durable.
     */
    if (propuestaEnviada) {
      this.realtime.emitToUser(pedido.usuarioId, 'propuesta.enviada', propuestaEnviada);
    }

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
        this.dispararEmailPrimeraRespuestaAsesor(mensaje.id, pedidoId).catch((err) =>
          this.logger.error(`Falló email MENSAJE_BODEGUERO (pedido ${pedidoId}): ${err.message}`),
        );
      }
    }

    return mensaje;
  }

  /**
   * F15 (sep 2026): marca de agua de lectura del chat (modelo WhatsApp/Telegram).
   *
   * El caller puede ser:
   *   - CLIENTE → bumpea `cliente_ultimo_mensaje_leido_id` (y, por implicación,
   *     `cliente_ultimo_mensaje_entregado_id`).
   *   - VENTAS / BODEGA_MONITOR / CAJERO / ADMIN → bumpea `tienda_ultimo_mensaje_leido_id`.
   *     El watermark es por LADO, no por usuario (1 asesor por tienda).
   *
   * Idempotente: nunca decrementa. Si el id actual ya es >= nuevo, no hace
   * nada. La transición se hace con `updateMany` y un guard OR en `where` para
   * evitar el clásico read-modify-write race entre dos pestañas abiertas.
   *
   * Después de bumpear, emite `mensaje.leido` al room del pedido y al cliente
   * para que el otro lado vea los ticks ✓✓ actualizarse en tiempo real.
   *
   * Oct 2026: el flag `entregado` del DTO se eliminó junto con su estado en el
   * frontend. El avance de `clienteUltimoMensajeEntregadoId` se conserva porque
   * un leído SIEMPRE implica entregado, y la columna sigue en BD como dato
   * histórico.
   */
  async marcarLeido(pedidoId: number, dto: MarcarLeidoDto, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);

    // El id del último mensaje que el caller vio. Si el caller pide bumpear
    // un id mayor al último mensaje real, lo clampeamos para no aceptar
    // ids bogus (defensa contra payloads manipulados).
    const maxId = await this.prisma.pedidoMensaje.aggregate({
      where: { pedidoId },
      _max: { id: true },
    });
    const ultimoId = Math.min(dto.ultimoMensajeId, maxId._max.id ?? dto.ultimoMensajeId);

    const esCliente = usuario.rol === RolUsuario.CLIENTE;
    const campoLeido = esCliente ? 'clienteUltimoMensajeLeidoId' : 'tiendaUltimoMensajeLeidoId';
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
    //
    // Oct 2026: ya no hay forma de pedir "entregado" sin "leído" — el flag se
    // eliminó del DTO. Este bloque se conserva porque la columna sigue en BD y
    // el invariante entregado >= leído debe mantenerse.
    if (esCliente) {
      await this.prisma.pedido.updateMany({
        where: {
          id: pedidoId,
          OR: [{ [campoEntregado]: null }, { [campoEntregado]: { lt: ultimoId } }],
        },
        data: { [campoEntregado]: ultimoId },
      });
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
