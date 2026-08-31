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
