import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolUsuario } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
