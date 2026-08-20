import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Adapter de envío SMTP (Nodemailer).
 *
 * Dev: usar MailHog (docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog)
 *      → SMTP_HOST=localhost, SMTP_PORT=1025, sin user/pass
 * Prod: cualquier SMTP estándar (Gmail con App Password, Resend via SMTP,
 *       SendGrid, etc.). Configurar las credenciales vía variables de entorno.
 */
@Injectable()
export class SmtpAdapter {
  private readonly logger = new Logger(SmtpAdapter.name);
  private transporter: nodemailer.Transporter;
  private fromAddress: string;

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('app.smtp.host') ?? 'localhost';
    const port = this.config.get<number>('app.smtp.port') ?? 1025;
    const user = this.config.get<string>('app.smtp.user') ?? '';
    const pass = this.config.get<string>('app.smtp.pass') ?? '';
    const secure = this.config.get<boolean>('app.smtp.secure') ?? false;
    this.fromAddress =
      this.config.get<string>('app.smtp.from') ?? 'no-reply@tienda.local';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      // Si no hay credenciales, MailHog las acepta vacías. En prod, la
      // presencia de SMTP_USER activa la auth.
      auth: user
        ? {
            user,
            pass,
          }
        : undefined,
      // En dev no queremos que Nodemailer muera si el certificado de MailHog
      // es auto-firmado. En prod, forzar TLS válido.
      tls: {
        rejectUnauthorized: this.config.get<string>('app.nodeEnv') === 'production',
      },
    });

    this.logger.log(`SMTP configurado: ${host}:${port} (secure=${secure})`);
  }

  async send(params: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    attachments?: nodemailer.SendMailOptions['attachments'];
  }): Promise<{ messageId: string; raw: any }> {
    const hasAttachments = (params.attachments?.length ?? 0) > 0;
    const info = await this.transporter.sendMail({
      from: this.fromAddress,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      attachments: params.attachments,
      // `related` indica que los adjuntos son recursos referenciados por el
      // HTML (logos cid:, css inline, etc.). Nodemailer pone el Content-Type
      // correcto en el multipart.
      ...(hasAttachments ? { enclosureType: 'multipart/related' } : {}),
    });
    this.logger.log(`Email enviado a ${params.to} (subject="${params.subject}")`);
    return { messageId: info.messageId, raw: info };
  }
}
