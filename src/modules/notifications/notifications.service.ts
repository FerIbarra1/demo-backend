import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pedido, TipoNotificacion } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { mailTemplates, mailSubjects } from '../mail/mail.templates';

/**
 * Servicio orquestador de notificaciones al cliente.
 *
 * Centraliza la decisión "¿qué email mandar para este evento?" y delega
 * el envío a `MailService` (que se encarga de render + SMTP + persistencia).
 *
 * Reglas de alcance:
 *   - Sólo se notifica a clientes (campo `pedido.clienteEmail`).
 *   - No se notifica a BODEGA / CAJERO / ADMIN / MOSTRADOR.
 *   - Cada tipo de notificación tiene su propia plantilla React Email y su
 *     propio subject.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private config: ConfigService,
  ) {}

  /**
   * Compone el email a partir del pedido + tipo, lo envía vía MailService
   * y devuelve los resultados para logging / inspección.
   *
   * Diseñado para llamarse fire-and-forget con `setImmediate(...)` desde los
   * puntos de transición de estado. NO debe lanzar errores al caller.
   */
  async enviar(pedido: Pedido, tipo: TipoNotificacion) {
    if (!pedido.clienteEmail) {
      this.logger.warn(
        `Pedido ${pedido.id} sin clienteEmail — no se envía notificación ${tipo}`,
      );
      return [{ canal: 'EMAIL', exitosa: false, errorMsg: 'sin email', destinatario: '' }];
    }

    // Cargamos los items (snapshot) y la tienda para alimentar la plantilla.
    const [items, tienda] = await Promise.all([
      this.prisma.itemPedido.findMany({
        where: { pedidoId: pedido.id, cancelada: false },
        orderBy: { id: 'asc' },
        include: {
          producto: { select: { imagenPrincipal: true } },
        },
      }),
      this.prisma.tienda.findUnique({ where: { id: pedido.tiendaId } }),
    ]);

    const logoUrl = this.config.get<string>('app.mail.logoUrl') ?? '';
    const frontendUrl = this.config.get<string>('app.mail.frontendUrl') ?? '';
    const pedidoUrl = `${frontendUrl}/pedidos/${pedido.id}`;
    const ctx = { logoUrl, frontendUrl };

    const pedidoData = {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      clienteNombre: pedido.clienteNombre,
      estado: pedido.estado,
      total: pedido.total,
      fechaPedido: pedido.fechaPedido,
      paqueteria: pedido.shippingPaqueteria ?? null,
      direccionEnvio: pedido.shippingDireccion ?? null,
      tiendaNombre: tienda?.nombre,
      tiendaTelefono: tienda?.telefono ?? undefined,
      items: items.map((it) => ({
        productoNombre: it.productoNombre,
        tallaNombre: it.tallaNombre,
        colorNombre: it.colorNombre,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
        imagenUrl: it.producto?.imagenPrincipal ?? null,
      })),
    };

    let template: ReturnType<typeof mailTemplates.PedidoRecibido> | null = null;
    let subject = '';

    switch (tipo) {
      case TipoNotificacion.PEDIDO_RECIBIDO:
        subject = mailSubjects.PEDIDO_RECIBIDO(pedido.numeroPedido);
        template = mailTemplates.PedidoRecibido({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.REVISION_PROPUESTA:
        subject = mailSubjects.REVISION_PROPUESTA(pedido.numeroPedido);
        // La propuesta puede o no traer un mensaje destacado del bodeguero.
        // Aquí no lo extraemos del chat; el caller puede pasar un mensaje
        // opcional vía `enviarPropuesta(pedido, mensaje)` si lo requiere.
        template = mailTemplates.RevisionPropuesta({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.REVISION_APROBADA:
        subject = mailSubjects.REVISION_APROBADA(pedido.numeroPedido);
        template = mailTemplates.PedidoAprobado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.PAGO_CONFIRMADO:
        subject = mailSubjects.PAGO_CONFIRMADO(pedido.numeroPedido);
        template = mailTemplates.PagoConfirmado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.ENVIADO:
        subject = mailSubjects.ENVIADO(pedido.numeroPedido);
        template = mailTemplates.PedidoEnviado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.ENTREGADO:
        subject = mailSubjects.ENTREGADO(pedido.numeroPedido);
        template = mailTemplates.PedidoEntregado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.CANCELADO:
        subject = mailSubjects.CANCELADO(pedido.numeroPedido);
        template = mailTemplates.PedidoCancelado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.MENSAJE_BODEGUERO:
      case TipoNotificacion.RESET_PASSWORD:
      case TipoNotificacion.BIENVENIDA:
      case TipoNotificacion.REVISION_RECHAZADA:
        // Tipos manejados por otros servicios directamente. No-op aquí.
        this.logger.warn(
          `TipoNotificacion ${tipo} no soportado en enviar() — usar el servicio específico`,
        );
        return [
          {
            canal: 'EMAIL',
            exitosa: false,
            errorMsg: 'tipo no soportado en este servicio',
            destinatario: pedido.clienteEmail,
          },
        ];
    }

    if (!template) {
      return [
        {
          canal: 'EMAIL',
          exitosa: false,
          errorMsg: 'no se pudo componer el template',
          destinatario: pedido.clienteEmail,
        },
      ];
    }

    const result = await this.mail.sendEmail({
      to: pedido.clienteEmail,
      subject,
      template,
      tipoNotificacion: tipo,
      pedidoId: pedido.id,
    });

    return [
      {
        canal: 'EMAIL' as const,
        exitosa: result.exitosa,
        errorMsg: result.errorMsg,
        destinatario: pedido.clienteEmail,
      },
    ];
  }

  /**
   * Variante para cuando la propuesta del bodeguero trae un mensaje
   * destacado que queremos resaltar en el email.
   */
  async enviarPropuesta(pedido: Pedido, mensajeBodeguero?: string) {
    if (!pedido.clienteEmail) return;
    const [items, tienda] = await Promise.all([
      this.prisma.itemPedido.findMany({
        where: { pedidoId: pedido.id, cancelada: false },
        orderBy: { id: 'asc' },
        include: {
          producto: { select: { imagenPrincipal: true } },
        },
      }),
      this.prisma.tienda.findUnique({ where: { id: pedido.tiendaId } }),
    ]);
    const logoUrl = this.config.get<string>('app.mail.logoUrl') ?? '';
    const frontendUrl = this.config.get<string>('app.mail.frontendUrl') ?? '';
    const pedidoUrl = `${frontendUrl}/pedidos/${pedido.id}`;

    const pedidoData = {
      pedidoId: pedido.id,
      numeroPedido: pedido.numeroPedido,
      clienteNombre: pedido.clienteNombre,
      estado: pedido.estado,
      total: pedido.total,
      fechaPedido: pedido.fechaPedido,
      tiendaNombre: tienda?.nombre,
      items: items.map((it) => ({
        productoNombre: it.productoNombre,
        tallaNombre: it.tallaNombre,
        colorNombre: it.colorNombre,
        cantidad: it.cantidad,
        precioUnitario: it.precioUnitario,
        subtotal: it.subtotal,
        imagenUrl: it.producto?.imagenPrincipal ?? null,
      })),
    };

    const template = mailTemplates.RevisionPropuesta({
      pedido: pedidoData,
      pedidoUrl,
      mensajeBodeguero,
      logoUrl,
      frontendUrl,
    });

    await this.mail.sendEmail({
      to: pedido.clienteEmail!,
      subject: mailSubjects.REVISION_PROPUESTA(pedido.numeroPedido),
      template,
      tipoNotificacion: TipoNotificacion.REVISION_PROPUESTA,
      pedidoId: pedido.id,
    });
  }
}
