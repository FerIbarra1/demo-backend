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

    // Si llega la tienda por header, la propagamos al request.user para
    // que esté disponible en el service. NO exigimos tienda en cada
    // request autenticada: la selección de tienda es por sesión y se
    // valida en los servicios que la requieren (ej. crearPedido).
    const request = context.switchToHttp().getRequest();
    const tiendaHeader = request.headers['x-tienda-id'];

    if (tiendaHeader) {
      const parsed = parseInt(tiendaHeader, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        user.tiendaIdHeader = parsed;
        // Mantenemos compatibilidad: si user.tiendaId no está set, lo
        // reflejamos desde el header (legacy code que lee user.tiendaId
        // todavía funciona).
        if (!user.tiendaId) {
          user.tiendaId = parsed;
        }
      }
    }

    return user;
  }
}
