import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Oct 2026: "sin estación solo se MIRA". Marca una ruta como acción de ATENDER: el cajero necesita
 * tener ventanilla y el operador de mostrador necesita tener mostrador. Lecturas (colas, detalle,
 * búsqueda) no la llevan.
 *
 * Va en el SERVIDOR y no solo en la pantalla: un cliente de la API, o una pantalla desfasada, no
 * puede saltársela. Antes solo `llamar-siguiente` exigía ventanilla; "Atender" no, así que un
 * cajero que liberaba su ventanilla (o que aún no elegía) seguía atendiendo: el pedido quedaba
 * asignado a un cajero SIN ventanilla y desaparecía de la TV y de la fila.
 *
 * ADMIN queda exento (soporte y pruebas). Otros roles pasan: solo aplica a CAJERO y MOSTRADOR.
 */
export const REQUIERE_ESTACION = 'requiere-estacion';
export const RequiereEstacion = () => SetMetadata(REQUIERE_ESTACION, true);

@Injectable()
export class EstacionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const exige = this.reflector.getAllAndOverride<boolean>(REQUIERE_ESTACION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!exige) return true;

    const user = ctx.switchToHttp().getRequest().user as
      | { userId: number; rol: RolUsuario; tiendaId?: number | null }
      | undefined;
    if (!user || user.rol === RolUsuario.ADMIN) return true;

    if (user.rol === RolUsuario.CAJERO) {
      const v = await this.prisma.ventanilla.findFirst({
        where: { cajeroId: user.userId },
        select: { id: true },
      });
      if (!v) {
        throw new ForbiddenException(
          'Elige una ventanilla para atender. Sin ella solo puedes mirar.',
        );
      }
    }

    if (user.rol === RolUsuario.MOSTRADOR) {
      const m = await this.prisma.mostrador.findFirst({
        where: { operadorId: user.userId },
        select: { id: true },
      });
      if (!m) {
        const hay = await this.prisma.mostrador.count({
          where: { tiendaId: user.tiendaId ?? -1, activa: true },
        });
        throw new ForbiddenException(
          hay > 0
            ? 'Elige tu mostrador para atender. Sin él solo puedes mirar.'
            : 'Esta tienda no tiene mostradores configurados: pide al admin que los cree.',
        );
      }
    }
    return true;
  }
}
