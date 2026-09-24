import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pedido, TipoNotificacion } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../imagenes/storage.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { MailService } from '../mail/mail.service';
import { mailTemplates, mailSubjects, folioVisible } from '../mail/mail.templates';
import { generarQrDataUrl } from '../pedidos/core/qr.util';
import { firmarLlegoQr } from '../pedidos/core/qr-llegada.util';

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
    private readonly storage: StorageService,
    private readonly configuracion: ConfiguracionService,
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

    const { pedidoData, ctx, pedidoUrl } = await this.componerPedidoData(pedido);

    let template: ReturnType<typeof mailTemplates.PedidoRecibido> | null = null;
    let subject = '';

    // El folio visible es UNO solo en todo el correo: el de VFP cuando existe.
    // Antes el asunto usaba `numeroPedido` (folio web) mientras el cuerpo usaba
    // `folioVisible()`, así que el mismo correo mostraba dos números distintos.
    const folio = folioVisible(pedidoData);

    switch (tipo) {
      case TipoNotificacion.PEDIDO_RECIBIDO:
        subject = mailSubjects.PEDIDO_RECIBIDO(folio);
        template = mailTemplates.PedidoRecibido({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.REVISION_PROPUESTA: {
        // La propuesta puede venir de bodega (faltantes) o del asesor de
        // ventas (contrapropuesta negociada). El estado es el mismo
        // (WAITING_CUSTOMER_APPROVAL), así que el origen se deduce de quién
        // la creó — si no, el cliente leía "el bodeguero" en una propuesta
        // de su asesor de ventas.
        const propuesta = await this.prisma.pedidoPropuesta.findFirst({
          where: { pedidoId: pedido.id, estado: 'PENDIENTE' },
          orderBy: { id: 'desc' },
          select: { creadaPorRol: true, nota: true },
        });
        const deVentas = propuesta?.creadaPorRol === 'VENTAS';
        subject = mailSubjects.REVISION_PROPUESTA(folio);
        template = mailTemplates.RevisionPropuesta({
          pedido: pedidoData,
          pedidoUrl,
          origen: deVentas ? 'ventas' : 'bodega',
          mensajeBodeguero: propuesta?.nota ?? undefined,
          ...ctx,
        });
        break;
      }
      // F13: el cliente pidió un asesor de ventas. Se le confirma que alguien
      // lo contactará. (El aviso al equipo de ventas va por realtime/cola.)
      case TipoNotificacion.ASESOR_SOLICITADO:
        subject = mailSubjects.ASESOR_SOLICITADO(folio);
        template = mailTemplates.RevisionPropuesta({
          pedido: pedidoData,
          pedidoUrl,
          origen: 'asesor',
          ...ctx,
        });
        break;
      // F13: el asesor de ventas envió una contrapropuesta.
      case TipoNotificacion.PROPUESTA_VENTAS:
        subject = mailSubjects.PROPUESTA_VENTAS(folio);
        template = mailTemplates.RevisionPropuesta({
          pedido: pedidoData,
          pedidoUrl,
          origen: 'ventas',
          ...ctx,
        });
        break;
      // F16: el pedido quedó apartado en tienda esperando que el cliente lo
      // revise antes de pagar. Es un estado que EXIGE acción del cliente, así
      // que necesita correo: antes no se notificaba y el cliente tenía que
      // presentarse en tienda sin saberlo.
      case TipoNotificacion.LISTO_EN_TIENDA:
        subject = mailSubjects.LISTO_EN_TIENDA(folio);
        template = mailTemplates.PedidoListoEnTienda({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.REVISION_APROBADA:
        subject = mailSubjects.REVISION_APROBADA(folio);
        template = mailTemplates.PedidoAprobado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.PAGO_CONFIRMADO:
        subject = mailSubjects.PAGO_CONFIRMADO(folio);
        template = mailTemplates.PagoConfirmado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.ENVIADO:
        subject = mailSubjects.ENVIADO(folio);
        template = mailTemplates.PedidoEnviado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.ENTREGADO:
        subject = mailSubjects.ENTREGADO(folio);
        template = mailTemplates.PedidoEntregado({
          pedido: pedidoData,
          pedidoUrl,
          ...ctx,
        });
        break;
      case TipoNotificacion.CANCELADO:
        subject = mailSubjects.CANCELADO(folio);
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
   * Arma los datos del pedido que consumen las plantillas.
   *
   * Centraliza tres cosas que antes se repetían (y divergían) entre `enviar()`
   * y `enviarListoParaPagar()`:
   *
   *   1. **Imagen por color**: cada item muestra la foto de SU color, no la
   *      principal del producto. El catálogo y el kiosko ya lo hacen así; el
   *      correo mostraba siempre la general. La cadena es
   *      `ItemPedido.precioCOId → PrecioCO.colorId → ProductoImagen.colorId`
   *      (ItemPedido no guarda colorId, sólo el nombre como snapshot).
   *   2. **Folio VFP**: se expone `externalFolio` para que las plantillas
   *      muestren el mismo número que el cliente ve en tienda y en el ERP.
   *   3. **Datos que existían pero nunca se pasaban**: motivo de cancelación
   *      (vive en `PedidoReposicion.motivo`) y folio VFP.
   */
  private async componerPedidoData(pedido: Pedido) {
    const [items, tienda, pendienteEnvio, reposicion] = await Promise.all([
      this.prisma.itemPedido.findMany({
        where: { pedidoId: pedido.id, cancelada: false },
        orderBy: { id: 'asc' },
        include: {
          producto: {
            select: {
              imagenPrincipal: true,
              // Imágenes por color, para elegir la del color del item.
              imagenesProducto: {
                select: { url: true, colorId: true, orden: true, esPrincipal: true },
                orderBy: [{ esPrincipal: 'desc' }, { orden: 'asc' }],
              },
            },
          },
          // colorId de la variante comprada.
          precioCO: { select: { colorId: true } },
        },
      }),
      this.prisma.tienda.findUnique({ where: { id: pedido.tiendaId } }),
      this.prisma.pedidoPendienteEnvio.findUnique({
        where: { pedidoId: pedido.id },
        select: { externalFolio: true },
      }),
      this.prisma.pedidoReposicion.findUnique({
        where: { pedidoId: pedido.id },
        select: { motivo: true },
      }),
    ]);

    const logoUrl = await this.configuracion.obtenerLogoUrl();
    const frontendUrl = this.config.get<string>('app.mail.frontendUrl') ?? '';
    const pedidoUrl = `${frontendUrl}/pedidos/${pedido.id}`;

    return {
      ctx: { logoUrl, frontendUrl },
      pedidoUrl,
      pedidoData: {
        pedidoId: pedido.id,
        numeroPedido: pedido.numeroPedido,
        externalFolio: pendienteEnvio?.externalFolio ?? null,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        total: pedido.total,
        fechaPedido: pedido.fechaPedido,
        paqueteria: pedido.shippingPaqueteria ?? null,
        direccionEnvio: pedido.shippingDireccion ?? null,
        motivoCancelacion: reposicion?.motivo ?? null,
        tiendaNombre: tienda?.nombre,
        tiendaTelefono: tienda?.telefono ?? undefined,
        items: items.map((it) => ({
          productoNombre: it.productoNombre,
          productoCodigo: it.productoCodigo,
          tallaNombre: it.tallaNombre,
          colorNombre: it.colorNombre,
          cantidad: it.cantidad,
          precioUnitario: it.precioUnitario,
          subtotal: it.subtotal,
          // URL absoluta: un cliente de correo no puede resolver rutas relativas.
          imagenUrl: this.imagenDelItem(it),
        })),
      },
    };
  }

  /**
   * Imagen del color que el cliente compró, con degradación en cascada:
   *   1. primera imagen de ese color (la principal si la marcó el admin)
   *   2. imagen principal del producto
   *   3. primera imagen disponible del producto
   *   4. null → la plantilla dibuja el placeholder con la inicial
   */
  private imagenDelItem(it: {
    producto?: {
      imagenPrincipal: string | null;
      imagenesProducto: Array<{ url: string; colorId: number | null }>;
    } | null;
    precioCO?: { colorId: number } | null;
  }): string | null {
    const delProducto = it.producto?.imagenesProducto ?? [];
    const colorId = it.precioCO?.colorId ?? null;

    const delColor = colorId
      ? delProducto.filter((i) => i.colorId === colorId)
      : [];

    const elegida =
      delColor[0]?.url ??
      it.producto?.imagenPrincipal ??
      delProducto[0]?.url ??
      null;

    return this.storage.resolverImagen(elegida);
  }

  /**
   * Email "listo para pagar" con el QR del folio VFP. Se dispara cuando el
   * agente confirma el ACK (externalFolio ya existe), no en confirmarSurtido.
   * Reutiliza el template PedidoAprobado (dice "aprobado y listo para pagar").
   * Fire-and-forget: no lanza errores al caller.
   */
  async enviarListoParaPagar(pedido: Pedido, externalFolio: string) {
    if (!pedido.clienteEmail) {
      this.logger.warn(
        `Pedido ${pedido.id} sin clienteEmail — no se envía email listo para pagar`,
      );
      return;
    }

    const { pedidoData: base, ctx, pedidoUrl } = await this.componerPedidoData(pedido);
    const { logoUrl, frontendUrl } = ctx;

    // PR8 (kiosko-profesional): QR firmado con HMAC (no folio plano).
    // Antes codificaba el externalFolio en claro, lo que permitía a
    // cualquiera con foto del recibo avisar llegada. Ahora el QR
    // apunta a este pedido + tienda + lleva firma criptográfica que
    // valida el kiosko. Multi-uso: el cliente puede presentar el mismo
    // QR varias veces (el server aplica idempotencia 60s).
    const kioskoQrSecret = this.config.get<string>('app.kioskoQrSecret') ?? '';
    const qrLlegoToken = kioskoQrSecret
      ? firmarLlegoQr(pedido.id, pedido.tiendaId, kioskoQrSecret)
      : null;
    const qrDataUrl = qrLlegoToken
      ? await generarQrDataUrl(qrLlegoToken)
      : await generarQrDataUrl(externalFolio);

    const pedidoData = { ...base, externalFolio, qrDataUrl };

    const template = mailTemplates.PedidoAprobado({
      pedido: pedidoData,
      pedidoUrl,
      qrDataUrl,
      logoUrl,
      frontendUrl,
    });

    await this.mail.sendEmail({
      to: pedido.clienteEmail,
      subject: mailSubjects.REVISION_APROBADA(externalFolio),
      template,
      tipoNotificacion: TipoNotificacion.REVISION_APROBADA,
      pedidoId: pedido.id,
    });
  }
}
