import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IS_API_KEY_AUTH_KEY } from '../decorators/api-key.decorator';

/**
 * Guard para endpoints protegidos por API key.
 *
 * Uso:
 * ```ts
 * @UseGuards(ApiKeyGuard)
 * @ApiKeyAuth()
 * @Post(':id/marcar-pagado')
 * async marcarPagado(...) { ... }
 * ```
 *
 * Valida que el header `X-Agent-Key` coincida con `app.agentApiKey`
 * (AGENT_API_KEY). Si pasa, inyecta `request.user = { id: null, nombre: 'AGENT',
 * rol: 'AGENT' }` para que los services puedan detectar el origen.
 *
 * También acepta tokens de ADMIN autenticado (rol ADMIN en JWT) — útil para
 * herramientas de soporte manual.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isApiKeyAuth = this.reflector.getAllAndOverride<boolean>(IS_API_KEY_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isApiKeyAuth) {
      // No-op si el endpoint no está marcado con @ApiKeyAuth().
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // 1) API key desde header (agente externo)
    const apiKey = request.headers['x-agent-key'];
    const expected = this.config.get<string>('app.agentApiKey');
    if (apiKey && expected && apiKey === expected) {
      request.user = {
        userId: 0,
        nombre: 'AGENT_EXTERNAL',
        rol: 'AGENT',
        source: 'X-Agent-Key',
      };
      return true;
    }

    // 2) JWT de ADMIN (soporte manual)
    const user = request.user;
    if (user && user.rol === 'ADMIN') {
      user.source = user.source ?? 'JWT_ADMIN';
      return true;
    }

    throw new UnauthorizedException(
      'Acceso denegado: requiere X-Agent-Key válida o JWT de ADMIN',
    );
  }
}
