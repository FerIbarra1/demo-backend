import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import { MailService } from '../mail/mail.service';
import { DtfCorreo } from '../mail/templates/DtfCorreo';
import { textoMotivoCorreccion, textoMotivoRechazo } from './core/dtf-motivos';

type TipoCorreoDtf = 'DTF_APROBADO' | 'DTF_NECESITA_CORRECCION' | 'DTF_RECHAZADO';

/** Avisos al cliente cuando Impresión decide algo sobre SU archivo. Nunca lanza: un correo caído no frena la cola. */
@Injectable()
export class DtfCorreosService {
  private readonly logger = new Logger(DtfCorreosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  async enviar(trabajoId: number, tipo: TipoCorreoDtf): Promise<void> {
    try {
      const t = await this.prisma.pedidoDtf.findUnique({
        where: { id: trabajoId },
        include: {
          usuario: true,
          pedido: {
            select: { id: true, numeroPedido: true, clienteEmail: true, clienteNombre: true },
          },
          tipo: true,
        },
      });
      if (!t?.pedido) return;
      const frontendUrl = (
        this.config.get<string>('app.mail.frontendUrl') ?? 'http://localhost:3001'
      ).replace(/\/$/, '');
      const logoUrl = await this.configuracion.obtenerLogoUrl();
      const url = `${frontendUrl}/pedidos/${t.pedido.id}`;
      const nombre = t.pedido.clienteNombre || t.usuario.nombre;
      const d = `"${t.nombre}" (${t.tipo.nombre})`;
      let asunto = '';
      let props: Parameters<typeof DtfCorreo>[0];
      const base = { saludo: `Hola, ${nombre}.`, logoUrl, frontendUrl };
      if (tipo === 'DTF_APROBADO') {
        asunto = `Tu archivo ${t.nombre} quedó aprobado`;
        const hora = t.horaEstimadaAt
          ? ` Estimamos tenerlo listo hacia las ${new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', timeZone: this.config.get('app.pagos.zonaHoraria') || 'America/Mexico_City' }).format(t.horaEstimadaAt)}.`
          : '';
        props = {
          ...base,
          preview: asunto,
          titulo: 'Tu archivo quedó aprobado',
          parrafos: [
            `Revisamos ${d} y está listo para imprimirse.${hora}`,
            'Te avisamos cuando esté listo en tienda.',
          ],
          boton: { texto: 'Ver mi pedido', url },
        };
      } else if (tipo === 'DTF_NECESITA_CORRECCION') {
        asunto = `Necesitamos que corrijas tu archivo ${t.nombre}`;
        const motivos = ((t.correccionMotivos as string[] | null) ?? []).map(textoMotivoCorreccion);
        if (t.correccionNota) motivos.push(t.correccionNota);
        props = {
          ...base,
          preview: asunto,
          titulo: 'Tu archivo necesita una corrección',
          parrafos: [
            `Al revisar ${d} encontramos algo que debe corregirse antes de imprimir. Sube una nueva versión desde tu pedido: no pierdes tu lugar en la fila.`,
          ],
          aviso: { variante: 'warning', etiqueta: 'Qué corregir', lineas: motivos },
          boton: { texto: 'Subir nueva versión', url },
        };
      } else {
        asunto = `No pudimos imprimir tu archivo ${t.nombre}`;
        const lineas = [textoMotivoRechazo(t.rechazoMotivo ?? 'OTRO')];
        if (t.rechazoNota) lineas.push(t.rechazoNota);
        props = {
          ...base,
          preview: asunto,
          titulo: 'No pudimos imprimir este trabajo',
          parrafos: [
            `Revisamos ${d} y no es posible imprimirlo. Tu pedido sigue su curso sin este trabajo y el total ya no lo incluye.`,
          ],
          aviso: { variante: 'danger', etiqueta: 'Motivo', lineas },
          boton: { texto: 'Ver mi pedido', url },
        };
      }
      await this.mail.sendEmail({
        to: t.pedido.clienteEmail || t.usuario.email,
        subject: asunto,
        template: DtfCorreo(props),
        tipoNotificacion: tipo,
        pedidoId: t.pedido.id,
      });
    } catch (e) {
      this.logger.error(`Correo ${tipo} del trabajo ${trabajoId} falló: ${(e as Error).message}`);
    }
  }
}
