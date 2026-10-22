import { RolUsuario } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';

/**
 * PLAN-ADMIN-MULTITIENDA F3 (oct 2026): el ADMIN conecta al socket pero solo entra a `admin:all`, NO a
 * `tienda-{id}`, así que no recibía ningún evento de la tienda que opera. `tienda.mirar` lo une al room de
 * ESA tienda (una a la vez) y `tienda.dejar-de-mirar` lo saca. Es la puerta a los eventos operativos de una
 * tienda (`pedido.llamado`, `ventanilla.*`…), así que se valida con las mismas reglas que el resto: solo un
 * ADMIN (re-comprobado en la BD: un token viejo de alguien degradado no vale), con una tienda bien formada
 * y que exista.
 */
describe('RealtimeGateway: tienda.mirar / tienda.dejar-de-mirar', () => {
  const crear = (opts: { usuario?: object | null; tiendas?: number[] } = {}) => {
    const usuario =
      opts.usuario === undefined
        ? { rol: RolUsuario.ADMIN, activo: true, deletedAt: null }
        : opts.usuario;
    const prisma = {
      usuario: { findUnique: jest.fn(async () => usuario) },
      tienda: {
        count: jest.fn(async ({ where }: { where: { id: number } }) =>
          (opts.tiendas ?? [1, 2, 3]).includes(where.id) ? 1 : 0,
        ),
      },
    };
    const gateway = new RealtimeGateway({} as never, {} as never, prisma as never);
    const client = (rol: RolUsuario = RolUsuario.ADMIN) => ({
      data: { userId: 1, rol, nombre: 'A' } as Record<string, unknown>,
      join: jest.fn(async () => undefined),
      leave: jest.fn(async () => undefined),
    });
    return { gateway, prisma, client };
  };
  const mirar = (g: RealtimeGateway, c: unknown, tiendaId: unknown) =>
    (
      g as unknown as {
        handleMirarTienda: (
          b: unknown,
          c: unknown,
        ) => Promise<{ ok: boolean; tiendaId?: number; error?: string }>;
      }
    ).handleMirarTienda({ tiendaId }, c);
  const dejar = (g: RealtimeGateway, c: unknown) =>
    (
      g as unknown as { handleDejarDeMirarTienda: (c: unknown) => Promise<{ ok: boolean }> }
    ).handleDejarDeMirarTienda(c);

  it('un ADMIN con una tienda válida entra al room de ESA tienda', async () => {
    const { gateway, client } = crear();
    const c = client();
    await expect(mirar(gateway, c, 2)).resolves.toEqual({ ok: true, tiendaId: 2 });
    expect(c.join).toHaveBeenCalledWith('tienda-2');
  });

  it('cambiar de tienda SALE de la anterior: nunca recibe eventos de dos tiendas mezclados', async () => {
    const { gateway, client } = crear();
    const c = client();
    await mirar(gateway, c, 1);
    await mirar(gateway, c, 2);
    expect(c.leave).toHaveBeenCalledWith('tienda-1');
    expect(c.join).toHaveBeenLastCalledWith('tienda-2');
  });

  it('mirar la misma tienda otra vez no hace nada (idempotente)', async () => {
    const { gateway, client } = crear();
    const c = client();
    await mirar(gateway, c, 1);
    c.join.mockClear();
    await expect(mirar(gateway, c, 1)).resolves.toEqual({ ok: true, tiendaId: 1 });
    expect(c.join).not.toHaveBeenCalled();
    expect(c.leave).not.toHaveBeenCalled();
  });

  it('dejar de mirar saca del room', async () => {
    const { gateway, client } = crear();
    const c = client();
    await mirar(gateway, c, 3);
    await expect(dejar(gateway, c)).resolves.toEqual({ ok: true });
    expect(c.leave).toHaveBeenCalledWith('tienda-3');
  });

  it.each([
    RolUsuario.CLIENTE,
    RolUsuario.BODEGA,
    RolUsuario.CAJERO,
    RolUsuario.MOSTRADOR,
    RolUsuario.TESORERIA,
  ])(
    '%s NO puede mirar la tienda que quiera (sería ver los eventos operativos de otra tienda)',
    async (rol) => {
      const { gateway, client } = crear({ usuario: { rol, activo: true, deletedAt: null } });
      const c = client(rol);
      const r = await mirar(gateway, c, 2);
      expect(r.ok).toBe(false);
      expect(c.join).not.toHaveBeenCalled();
    },
  );

  it('un token de ADMIN de alguien que YA no lo es (degradado o dado de baja) no sirve: se re-comprueba en la BD', async () => {
    for (const usuario of [
      { rol: RolUsuario.CAJERO, activo: true, deletedAt: null },
      { rol: RolUsuario.ADMIN, activo: false, deletedAt: null },
      { rol: RolUsuario.ADMIN, activo: true, deletedAt: new Date() },
      null,
    ]) {
      const { gateway, client } = crear({ usuario });
      const c = client(RolUsuario.ADMIN);
      expect((await mirar(gateway, c, 1)).ok).toBe(false);
      expect(c.join).not.toHaveBeenCalled();
    }
  });

  it.each(['abc', 0, -1, 1.5, '1e3', null, undefined, [1, 2], 99999999999])(
    'una tienda mal formada (%p) se rechaza sin tocar la BD',
    async (mala) => {
      const { gateway, client, prisma } = crear();
      const c = client();
      expect((await mirar(gateway, c, mala)).ok).toBe(false);
      expect(prisma.tienda.count).not.toHaveBeenCalled();
      expect(c.join).not.toHaveBeenCalled();
    },
  );

  it('una tienda que no existe se rechaza', async () => {
    const { gateway, client } = crear({ tiendas: [1] });
    const c = client();
    expect((await mirar(gateway, c, 7)).ok).toBe(false);
    expect(c.join).not.toHaveBeenCalled();
  });

  it('si la tienda nueva se rechaza, NO se sale de la que ya miraba', async () => {
    const { gateway, client } = crear({ tiendas: [1] });
    const c = client();
    await mirar(gateway, c, 1);
    await mirar(gateway, c, 7);
    expect(c.leave).not.toHaveBeenCalled();
  });
});
