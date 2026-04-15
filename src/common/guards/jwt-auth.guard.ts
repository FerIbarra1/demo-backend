import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RolUsuario } from '@prisma/client';

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

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException('Token inválido o expirado');
    }

    // Validar que se especifique tienda para clientes
    const request = context.switchToHttp().getRequest();
    const tiendaHeader = request.headers['x-tienda-id'];

    if (user.rol === RolUsuario.CLIENTE && !user.tiendaId && !tiendaHeader) {
      throw new UnauthorizedException('Debe seleccionar una tienda (header X-Tienda-Id)');
    }

    // Asignar tienda del header si no la tiene
    if (!user.tiendaId && tiendaHeader) {
      user.tiendaId = parseInt(tiendaHeader, 10);
    }

    return user;
  }
}
