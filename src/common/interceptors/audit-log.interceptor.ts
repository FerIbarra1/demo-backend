import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Intercepta requests HTTP para registrar mutaciones (POST, PUT, PATCH, DELETE)
 * en la tabla `LogActividad`. Sólo auditamos mutaciones; las lecturas no se
 * registran para no inflar la tabla.
 *
 * Si la mutación falla, registramos la accion con metadata del error.
 *
 * El interceptor se aplica globalmente vía APP_INTERCEPTOR en app.module.ts.
 * Los endpoints @Public() también pasan por aquí (no hay forma nativa de
 * excluirlos), pero como son lecturas o login no se loguean.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    if (!req) return next.handle();

    const method = (req.method || 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    // Saltar Swagger, healthchecks y auth login/register/refresh para no inflar
    const url: string = req.originalUrl || req.url || '';
    if (url.includes('/api/docs') || url.includes('/api/health')) {
      return next.handle();
    }

    const user = req.user;
    const usuarioId = user?.userId ?? null;
    const usuarioNombre = user?.nombre ?? null;
    const ipAddress =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;
    const userAgent = req.headers['user-agent'] || null;

    const accion = `${method} ${this.normalizarUrl(url)}`;
    const descripcion = `${method} ${url}`;
    const metadata = {
      body: this.sanitizarBody(req.body),
      params: req.params,
      query: req.query,
    };

    return next.handle().pipe(
      tap(() => {
        this.registrar(usuarioId, usuarioNombre, accion, descripcion, ipAddress, userAgent, metadata, null).catch(
          (err) => this.logger.warn(`audit log falló: ${err.message}`),
        );
      }),
      catchError((err) => {
        this.registrar(
          usuarioId,
          usuarioNombre,
          accion,
          descripcion,
          ipAddress,
          userAgent,
          metadata,
          err?.message ?? 'Error',
        ).catch((e) => this.logger.warn(`audit log falló: ${e.message}`));
        return throwError(() => err);
      }),
    );
  }

  /**
   * Quita campos sensibles del body antes de persistir el log.
   * Sobre todo password y tokens.
   */
  private sanitizarBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const clone: any = Array.isArray(body) ? [...body] : { ...body };
    for (const k of Object.keys(clone)) {
      if (/password|token|secret|authorization/i.test(k)) {
        clone[k] = '[REDACTED]';
      }
    }
    return clone;
  }

  private normalizarUrl(url: string): string {
    // Quita query string y reemplaza IDs numéricos por :id para agrupar
    const sinQuery = url.split('?')[0];
    return sinQuery.replace(/\/\d+(?=\/|$)/g, '/:id');
  }

  private async registrar(
    usuarioId: number | null,
    usuarioNombre: string | null,
    accion: string,
    descripcion: string,
    ipAddress: string | null,
    userAgent: string | null,
    metadata: any,
    errorMsg: string | null,
  ): Promise<void> {
    try {
      await this.prisma.logActividad.create({
        data: {
          usuarioId: usuarioId ?? undefined,
          accion: accion.slice(0, 50),
          descripcion: errorMsg ? `${descripcion} [ERROR: ${errorMsg}]` : descripcion,
          ipAddress,
          userAgent,
          metadata: metadata as any,
        },
      });
    } catch (err) {
      this.logger.warn(`No se pudo escribir log de auditoría: ${err.message}`);
    }
  }
}