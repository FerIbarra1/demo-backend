import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { resolverTiendaDeConsola, TiendaConsolaGuard } from './tienda-consola';

/**
 * PLAN-ADMIN-MULTITIENDA §4.1 (oct 2026): UNA función decide de qué tienda es una consola.
 *
 * Antes cada controller armaba su ternario (`ADMIN ? (?tiendaId ?? user.tiendaId) : user.tiendaId`) y
 * los que no lo copiaron leían `user.tiendaId` a secas. Dos fallas distintas salían de ahí:
 *  - el ADMIN (sin tienda en el token) recibía 500 en mostrador, o —peor— en bodega un `where` SIN
 *    tienda: la cola de TODAS las tiendas mezclada;
 *  - cualquier cambio a "quién puede pedir qué tienda" había que repetirlo en 15 sitios.
 *
 * La regla de oro no cambia: la tienda de un empleado sale SOLO del JWT. Un `?tiendaId=` de un
 * no-ADMIN se IGNORA (no se rechaza ni se usa): con el header o el query habría IDOR entre tiendas.
 */

const usuario = (rol: RolUsuario, tiendaId?: number) => ({
  userId: 10,
  nombre: 'Prueba',
  rol,
  tiendaId,
});

describe('resolverTiendaDeConsola', () => {
  const noAdmin = Object.values(RolUsuario).filter((r) => r !== RolUsuario.ADMIN);

  describe('empleados: la tienda sale SOLO del token', () => {
    it.each(noAdmin)('%s usa la suya y descarta cualquier ?tiendaId=', (rol) => {
      expect(resolverTiendaDeConsola(usuario(rol, 1), undefined)).toBe(1);
      expect(resolverTiendaDeConsola(usuario(rol, 1), '2')).toBe(1);
      expect(resolverTiendaDeConsola(usuario(rol, 1), 2)).toBe(1);
      expect(resolverTiendaDeConsola(usuario(rol, 1), ['2', '3'])).toBe(1);
      // Basura en el query tampoco hace nada: se ignora entera, no se valida.
      expect(resolverTiendaDeConsola(usuario(rol, 1), 'abc')).toBe(1);
      expect(resolverTiendaDeConsola(usuario(rol, 1), '-5')).toBe(1);
    });

    it('un empleado sin tienda recibe 403 (no 400: no es algo que él pueda elegir)', () => {
      expect(() => resolverTiendaDeConsola(usuario(RolUsuario.MOSTRADOR), '2')).toThrow(
        ForbiddenException,
      );
      expect(() => resolverTiendaDeConsola(usuario(RolUsuario.BODEGA), undefined)).toThrow(
        ForbiddenException,
      );
    });

    it('un usuario ausente falla cerrado (403)', () => {
      expect(() => resolverTiendaDeConsola(undefined, '2')).toThrow(ForbiddenException);
      expect(() => resolverTiendaDeConsola(null, '2')).toThrow(ForbiddenException);
    });
  });

  describe('ADMIN: elige la tienda y el servidor la valida', () => {
    const admin = usuario(RolUsuario.ADMIN);

    it('usa la tienda del query (texto o número)', () => {
      expect(resolverTiendaDeConsola(admin, '2')).toBe(2);
      expect(resolverTiendaDeConsola(admin, 2)).toBe(2);
      expect(resolverTiendaDeConsola(admin, ' 7 ')).toBe(7);
    });

    it('sin tienda elegida: 400 "Elige una tienda" (antes: 500, o la cola de todas las tiendas)', () => {
      for (const vacio of [undefined, null, '', '   ']) {
        expect(() => resolverTiendaDeConsola(admin, vacio)).toThrow(BadRequestException);
        expect(() => resolverTiendaDeConsola(admin, vacio)).toThrow('Elige una tienda');
      }
    });

    it.each([
      'abc',
      '0',
      '-1',
      '1.5',
      '1e3',
      '0x10',
      '2 3',
      '99999999999',
      NaN,
      0,
      -3,
      1.5,
      ['1', '2'],
      {},
    ])('un tiendaId inválido (%p) es 400, no se "arregla" en silencio', (malo) => {
      expect(() => resolverTiendaDeConsola(admin, malo)).toThrow(BadRequestException);
      expect(() => resolverTiendaDeConsola(admin, malo)).toThrow('tiendaId');
    });

    it('un ADMIN que SÍ trae tienda en el token la usa si no elige otra (compat. con impresión)', () => {
      expect(resolverTiendaDeConsola(usuario(RolUsuario.ADMIN, 3), undefined)).toBe(3);
      expect(resolverTiendaDeConsola(usuario(RolUsuario.ADMIN, 3), '2')).toBe(2);
    });
  });

  describe('opcional: para lo que es un indicador, no una lista (el badge de reposición)', () => {
    it('devuelve undefined en vez de lanzar cuando no hay tienda', () => {
      expect(
        resolverTiendaDeConsola(usuario(RolUsuario.ADMIN), undefined, { opcional: true }),
      ).toBeUndefined();
      expect(
        resolverTiendaDeConsola(usuario(RolUsuario.BODEGA), undefined, { opcional: true }),
      ).toBeUndefined();
    });

    it('con tienda se comporta igual que la función normal', () => {
      expect(resolverTiendaDeConsola(usuario(RolUsuario.ADMIN), '2', { opcional: true })).toBe(2);
      expect(resolverTiendaDeConsola(usuario(RolUsuario.BODEGA, 1), '2', { opcional: true })).toBe(
        1,
      );
    });

    it('un tiendaId malformado del ADMIN sigue siendo 400', () => {
      expect(() =>
        resolverTiendaDeConsola(usuario(RolUsuario.ADMIN), 'abc', { opcional: true }),
      ).toThrow(BadRequestException);
    });
  });
});

describe('TiendaConsolaGuard: que la tienda que elige el ADMIN exista', () => {
  const contexto = (user: unknown, query: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, query }) }),
    }) as unknown as ExecutionContext;

  const crear = (existentes: number[]) => {
    const count = jest.fn(async ({ where }: { where: { id: number } }) =>
      existentes.includes(where.id) ? 1 : 0,
    );
    return { guard: new TiendaConsolaGuard({ tienda: { count } } as never), count };
  };

  it('ADMIN con una tienda que existe: pasa', async () => {
    const { guard } = crear([1, 2]);
    await expect(
      guard.canActivate(contexto(usuario(RolUsuario.ADMIN), { tiendaId: '2' })),
    ).resolves.toBe(true);
  });

  it('ADMIN con una tienda que NO existe: 404 con un mensaje que se entiende', async () => {
    const { guard } = crear([1, 2]);
    const r = guard.canActivate(contexto(usuario(RolUsuario.ADMIN), { tiendaId: '99' }));
    await expect(r).rejects.toThrow(NotFoundException);
    await expect(r).rejects.toThrow('La tienda no existe');
  });

  it('un empleado NUNCA toca la BD (su tienda ya viene del token)', async () => {
    const { guard, count } = crear([]);
    await expect(
      guard.canActivate(contexto(usuario(RolUsuario.MOSTRADOR, 1), { tiendaId: '99' })),
    ).resolves.toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it('sin tiendaId, o malformado, no consulta: de eso se encarga la función (400)', async () => {
    const { guard, count } = crear([]);
    for (const query of [
      {},
      { tiendaId: '' },
      { tiendaId: 'abc' },
      { tiendaId: '0' },
      { tiendaId: ['1', '2'] },
    ]) {
      await expect(guard.canActivate(contexto(usuario(RolUsuario.ADMIN), query))).resolves.toBe(
        true,
      );
    }
    expect(count).not.toHaveBeenCalled();
  });

  it('un ADMIN con tienda en el token y sin query no consulta nada', async () => {
    const { guard, count } = crear([]);
    await expect(guard.canActivate(contexto(usuario(RolUsuario.ADMIN, 3), {}))).resolves.toBe(true);
    expect(count).not.toHaveBeenCalled();
  });
});
