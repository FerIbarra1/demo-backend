import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DtfTrabajoService } from './dtf-trabajo.service';

/**
 * Valida el token del enlace "sube desde tu celular" ANTES de que Multer reciba el cuerpo.
 *
 * La ruta es pública (el token ES la autorización) y Multer escribe el archivo a disco antes de que el handler corra:
 * sin este guard, cualquier anónimo podía mandar hasta 300 MB por petición con un token inventado, el handler lanzaba
 * 403 y el temporal se quedaba en `tmpdir()` (su limpieza vive dentro de `subirArchivo`, que ya no se alcanza). Un
 * guard corre ANTES de los interceptores: un token inválido o vencido se rechaza sin escribir un solo byte.
 * La verificación es una firma HMAC (sin BD), así que cuesta lo mismo que rechazar.
 */
@Injectable()
export class DtfMovilGuard implements CanActivate {
  constructor(private readonly trabajos: DtfTrabajoService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest().params?.token as string;
    this.trabajos.actorMovil(token); // lanza 403 si no es válido o venció
    return true;
  }
}
