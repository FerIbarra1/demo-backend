import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

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
      nombre: usuario.nombre,
    };
  }
}
