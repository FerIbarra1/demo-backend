import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_API_KEY_AUTH_KEY } from '../decorators/api-key.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Rutas de API key (agente externo de Firebird): se autentican con
    // `ApiKeyGuard`, que va declarado a nivel de controller.
    //
    // Los guards globales corren ANTES que los de controller, así que sin esta
    // excepción este guard exige un JWT y rechaza al agente con 401 antes de
    // que `ApiKeyGuard` llegue a evaluar el header `X-Agent-Key`. El agente no
    // tiene JWT: no es un usuario. La autorización de esas rutas es
    // enteramente responsabilidad de `ApiKeyGuard`.
    const isApiKeyAuth = this.reflector.getAllAndOverride<boolean>(IS_API_KEY_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isApiKeyAuth) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, _info: any, _context: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException('Token inválido o expirado');
    }

    // La tienda efectiva del usuario viene SOLO del JWT/BD (JwtStrategy).
    // NO se refleja el header X-Tienda-Id en user.tiendaId: confiar en un
    // header client-side para autorización permitiría IDOR cross-tienda.
    // La selección de tienda del cliente se lee explícitamente en
    // cliente.controller.ts y se valida contra usuarioTienda en crearPedido.
    return user;
  }
}
