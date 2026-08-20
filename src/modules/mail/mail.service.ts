import { Injectable, Logger } from '@nestjs/common';
import { render } from '@react-email/render';
import { ReactElement } from 'react';
import { CanalNotificacion, TipoNotificacion } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SmtpAdapter } from './adapters/smtp.adapter';

/**
 * Opciones de envío de un email.
 * `template` es un ReactElement generado por una de las plantillas del módulo.
 * `pedidoId` es opcional (los emails transaccionales no relacionados a un
 * pedido — p.ej. RESET_PASSWORD o BIENVENIDA — lo dejan en undefined).
 */
export interface SendEmailOptions {
  to: string;
  subject: string;
  template: ReactElement;
  tipoNotificacion: TipoNotificacion;
  pedidoId?: number;
  // Texto plano opcional que se manda junto al HTML (fallback para clientes
  // de correo que no renderizan HTML).
  textFallback?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private prisma: PrismaService,
    private smtp: SmtpAdapter,
  ) {}

  /**
   * Renderiza el template React Email a HTML + texto plano, envía vía SMTP y
   * persiste el resultado en la tabla `Notificacion` (canal=EMAIL) para
   * auditoría.
   *
   * Diseñado para llamarse fire-and-forget con `setImmediate(...)` desde los
   * puntos de transición. NO lanza errores hacia el caller: cualquier fallo
   * se loguea y se persiste como `exitosa=false` en la tabla.
   */
  async sendEmail(opts: SendEmailOptions): Promise<{ exitosa: boolean; errorMsg?: string }> {
    let html: string;
    let text: string;
    try {
      html = await render(opts.template);
      // @react-email/render no expone `render` para texto plano en versiones
      // recientes, así que generamos un fallback simple a partir del subject
      // o del texto provisto por el caller.
      text =
        opts.textFallback ??
        `${opts.subject}\n\nPor favor visualiza este correo en un cliente que soporte HTML.`;
    } catch (err: any) {
      this.logger.error(`Falló render del template ${opts.tipoNotificacion}: ${err.message}`);
      await this.persistirNotificacion(opts, '', '', false, `Render error: ${err.message}`);
      return { exitosa: false, errorMsg: err.message };
    }

    try {
      const result = await this.smtp.send({
        to: opts.to,
        subject: opts.subject,
        html,
        text,
      });
      await this.persistirNotificacion(opts, html, text, true, undefined, {
        messageId: result.messageId,
      });
      return { exitosa: true };
    } catch (err: any) {
      this.logger.error(
        `Falló envío SMTP a ${opts.to} (tipo=${opts.tipoNotificacion}): ${err.message}`,
      );
      await this.persistirNotificacion(opts, html, text, false, err.message);
      return { exitosa: false, errorMsg: err.message };
    }
  }

  private async persistirNotificacion(
    opts: SendEmailOptions,
    html: string,
    text: string,
    exitosa: boolean,
    errorMsg?: string,
    extra?: any,
  ) {
    try {
      await this.prisma.notificacion.create({
        data: {
          pedidoId: opts.pedidoId ?? null,
          canal: CanalNotificacion.EMAIL,
          tipo: opts.tipoNotificacion,
          destinatario: opts.to,
          exitosa,
          errorMsg: errorMsg ?? null,
          payload: {
            subject: opts.subject,
            htmlLength: html.length,
            textLength: text.length,
            ...extra,
          },
        },
      });
    } catch (err: any) {
      this.logger.error(`No se pudo persistir Notificacion: ${err.message}`);
    }
  }
}
