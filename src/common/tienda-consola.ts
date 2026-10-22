import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PLAN-ADMIN-MULTITIENDA §4.1 (oct 2026): de qué tienda es una consola. UNA función, un solo sitio.
 *
 * Antes cada controller armaba su ternario (`ADMIN ? (?tiendaId ?? user.tiendaId) : user.tiendaId`) y
 * los que no lo copiaron leían `user.tiendaId` a secas. El ADMIN no trae tienda en el token, así que:
 *  - mostrador respondía 500;
 *  - bodega filtraba `if (tiendaId) where.tiendaId = …`: sin tienda, la cola de TODAS las tiendas mezclada.
 *
 * Reglas (no negociables):
 *  1. La tienda de un empleado sale SOLO del JWT. Un `?tiendaId=` de un no-ADMIN se IGNORA (ni se rechaza
 *     ni se usa): con el query o el header habría IDOR entre tiendas.
 *  2. El ADMIN elige la tienda y el servidor la valida (entero > 0 que quepa en un `Int` de Postgres; que
 *     exista lo comprueba `TiendaConsolaGuard`). Una tienda a la vez: nunca "todas mezcladas" (D1).
 *  3. Fallar con un mensaje, no con 500: ADMIN sin tienda → 400 "Elige una tienda" (la pantalla ya sabe
 *     pintarlo); empleado sin tienda → 403 (no es algo que él pueda elegir).
 *
 * Contrato con el spec `tienda-consola-contrato.spec.ts`: un controller de consola NO lee `user.tiendaId`
 * ni `@Query('tiendaId')` por su cuenta; usa `@TiendaConsola()`.
 */

interface UsuarioDeConsola {
  rol: RolUsuario;
  tiendaId?: number | null;
}

export interface OpcionesTiendaConsola {
  /**
   * Para un INDICADOR (el badge de reposición) y no una lista: sin tienda devuelve `undefined` en vez de
   * lanzar, y el controller responde 0. Un tiendaId mal formado del ADMIN sigue siendo 400.
   */
  opcional?: boolean;
}

/** Tope de un `Int` de Postgres: más allá, Prisma falla con un 500 en vez de decir "no existe". */
const INT4_MAX = 2_147_483_647;

/**
 * Lo que el ADMIN pidió: el id, `undefined` si no mandó nada, o `null` si mandó algo que no es un id
 * (texto, decimal, negativo, cero, arreglo por repetir el parámetro, fuera de rango). Estricto a propósito:
 * `parseInt('2abc')` daría 2 y `Number('1e3')` daría 1000; aquí ninguna de las dos pasa.
 */
export function leerTiendaElegida(crudo: unknown): number | undefined | null {
  if (crudo === undefined || crudo === null) return undefined;
  let n: number;
  if (typeof crudo === 'number') {
    n = crudo;
  } else if (typeof crudo === 'string') {
    const texto = crudo.trim();
    if (texto === '') return undefined;
    if (!/^\d+$/.test(texto)) return null;
    n = Number(texto);
  } else {
    return null;
  }
  return Number.isSafeInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

export function resolverTiendaDeConsola(
  user: UsuarioDeConsola | null | undefined,
  tiendaIdQuery?: unknown,
): number;
export function resolverTiendaDeConsola(
  user: UsuarioDeConsola | null | undefined,
  tiendaIdQuery: unknown,
  opts: { opcional: true },
): number | undefined;
export function resolverTiendaDeConsola(
  user: UsuarioDeConsola | null | undefined,
  tiendaIdQuery?: unknown,
  opts?: OpcionesTiendaConsola,
): number | undefined {
  if (user?.rol === RolUsuario.ADMIN) {
    const elegida = leerTiendaElegida(tiendaIdQuery);
    if (elegida === null) {
      throw new BadRequestException('tiendaId inválida: debe ser el número de una tienda.');
    }
    // Un ADMIN que SÍ trae tienda en el token la usa si no elige otra (así ya funcionaba en impresión).
    const tienda = elegida ?? user.tiendaId ?? undefined;
    if (tienda) return tienda;
    if (opts?.opcional) return undefined;
    throw new BadRequestException('Elige una tienda');
  }

  // Cualquier otro rol: la del token, y el query ni se mira.
  if (user?.tiendaId) return user.tiendaId;
  if (opts?.opcional) return undefined;
  throw new ForbiddenException('Tu usuario no tiene tienda asignada.');
}

/**
 * `@TiendaConsola() tienda: number` — la tienda de la consola para esta petición (ver arriba).
 * `@TiendaConsola({ opcional: true }) tienda?: number` para un indicador.
 */
export const TiendaConsola = createParamDecorator(
  (opts: OpcionesTiendaConsola | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    return resolverTiendaDeConsola(req.user, req.query?.tiendaId, {
      opcional: opts?.opcional === true,
    } as {
      opcional: true;
    });
  },
);

/** Swagger: el mismo texto en todos los endpoints de consola (antes, un `@ApiQuery` copiado en cada uno). */
export const ApiTiendaConsola = () =>
  ApiQuery({
    name: 'tiendaId',
    required: false,
    type: Number,
    description:
      'Solo ADMIN: la tienda de la consola (obligatoria para él; sin ella, 400 "Elige una tienda"). ' +
      'Se IGNORA para el resto de roles: su tienda sale del token.',
  });

/**
 * Que la tienda que elige el ADMIN EXISTA: 404 "La tienda no existe" en vez de una lista vacía que se
 * lee como "esta tienda no tiene pedidos". Solo consulta la BD para un ADMIN con un id bien formado; el
 * resto (sin id, mal formado, otro rol) lo resuelve `resolverTiendaDeConsola` sin tocarla.
 *
 * Va aparte de la función porque ésta es pura y síncrona (la usa también un decorador de parámetro, que
 * no puede esperar a la BD). Es opcional: sin él, un id inexistente solo produce listas vacías.
 */
@Injectable()
export class TiendaConsolaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (req.user?.rol !== RolUsuario.ADMIN) return true;

    const elegida = leerTiendaElegida(req.query?.tiendaId);
    if (!elegida) return true;

    const existe = await this.prisma.tienda.count({ where: { id: elegida } });
    if (!existe) throw new NotFoundException('La tienda no existe');
    return true;
  }
}
