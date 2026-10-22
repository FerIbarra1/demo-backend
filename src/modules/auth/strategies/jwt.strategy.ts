import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { nombreDeActor } from '../../../common/nombre-actor';
import { esTokenDeAcceso } from '../token-acceso.util';

interface JwtPayload {
  sub: number;
  email: string;
  rol: string;
  tiendaId?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('app.jwtSecret')!,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    // El refresh token y el del QR del kiosko comparten secreto y `sub`, pero NO son tokens de acceso.
    if (!esTokenDeAcceso(payload)) throw new UnauthorizedException('Token inválido o expirado');

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: payload.sub },
      include: { tienda: true },
    });

    // `deletedAt` además de `activo`: `eliminar()` marca los dos, pero la baja lógica no
    // debe depender de que alguien recuerde apagar el otro flag.
    if (!usuario || !usuario.activo || usuario.deletedAt !== null) {
      throw new UnauthorizedException('Usuario no encontrado o inactivo');
    }

    return {
      userId: payload.sub,
      email: payload.email,
      // Oct 2026: el rol sale de la BD, NO del token. `tiendaId` ya salía de la BD, pero
      // `rol` se copiaba del token firmado: cambiarle el rol a un empleado (o quitarle
      // el de ADMIN) no surtía efecto hasta que expiraba su access token, aunque las
      // sesiones nuevas ya vinieran con el rol correcto. Con un rol que tocará dinero,
      // el permiso tiene que ser el de ahora, no el de cuando inició sesión.
      rol: usuario.rol,
      tiendaId: usuario.tiendaId,
      // Oct 2026 (PLAN-ADMIN-MULTITIENDA §4.5.3): este nombre es el que acaba en el historial, en los avisos y en
      // los eventos de lo que se haga con esta sesión. Al ADMIN se le agrega su rol aquí, una sola vez, y no en
      // cada sitio que escribe `usuario.nombre`: sus acciones en la tienda de otro no se confunden con las de un
      // empleado de esa tienda.
      nombre: nombreDeActor(usuario),
    };
  }
}
