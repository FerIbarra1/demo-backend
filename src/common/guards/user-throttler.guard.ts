import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Oct 2026: el límite de peticiones cuenta POR PERSONA cuando hay sesión y por IP cuando no la hay.
 *
 * El `ThrottlerGuard` de fábrica cuenta por IP. Una tienda entera sale a internet por UNA IP pública (varias
 * consolas, tablets y PCs, cada una con su polling): contadas juntas toparían con el 429 en hora pico sin que
 * nadie abusara de nada. Con sesión, el contador es del usuario; sin ella (login, registro, TV de pared, kiosko)
 * no queda otra que la IP.
 *
 * Se confía en `req.user` porque `JwtAuthGuard` corre ANTES (es el primer `APP_GUARD`) y solo lo puebla si validó
 * la firma del token. NO se usan cabeceras que manda el cliente (`X-Kiosko-Id`, `X-Tienda-Id`): son del atacante y
 * rotarlas esquivaría el límite. Por eso las tablets de kiosko siguen contando por IP.
 *
 * La clave de Nest ya incluye clase y handler: el tope es por ruta y por rastreador, no un cubo único.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req.user?.userId;
    if (typeof userId === 'number' && Number.isFinite(userId)) return `usuario:${userId}`;
    return `ip:${req.ip ?? 'desconocida'}`;
  }
}
