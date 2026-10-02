import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolUsuario } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_API_KEY_AUTH_KEY } from '../decorators/api-key.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Rutas de API key (agente externo de Firebird): el agente no es un
    // usuario y no tiene rol, así que un `@Roles(...)` a nivel de clase lo
    // rechazaría con 403. Su autorización es de `ApiKeyGuard`, no de roles.
    // Mismo motivo que en `JwtAuthGuard`.
    const isApiKeyAuth = this.reflector.getAllAndOverride<boolean>(IS_API_KEY_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isApiKeyAuth) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<RolUsuario[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Sin @Roles() el endpoint es accesible para cualquier rol autenticado.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new ForbiddenException('Usuario no autenticado');
    }

    // ADMIN pasa siempre (superusuario).
    if (user.rol === RolUsuario.ADMIN) {
      return true;
    }

    if (requiredRoles.includes(user.rol)) {
      return true;
    }

    throw new ForbiddenException(
      `Acceso denegado: rol ${user.rol} no autorizado para este recurso`,
    );
  }
}
