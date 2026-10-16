import { ForbiddenException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { EstacionGuard } from './estacion.guard';

/**
 * Oct 2026: "sin estación solo se mira". El servidor rechaza las acciones de atender del cajero sin
 * ventanilla y del operador sin mostrador — aunque llamen a la API directo.
 */
function crear(opts: { ventanilla?: boolean; mostrador?: boolean; mostradoresEnTienda?: number; exige?: boolean }) {
  const prisma = {
    ventanilla: { findFirst: jest.fn().mockResolvedValue(opts.ventanilla ? { id: 1 } : null) },
    mostrador: {
      findFirst: jest.fn().mockResolvedValue(opts.mostrador ? { id: 1 } : null),
      count: jest.fn().mockResolvedValue(opts.mostradoresEnTienda ?? 0),
    },
  };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(opts.exige ?? true) };
  const guard = new EstacionGuard(reflector as never, prisma as never);
  const ctx = (user: unknown) =>
    ({
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;
  return { guard, ctx, prisma };
}
const cajero = { userId: 3, rol: RolUsuario.CAJERO, tiendaId: 5 };
const operador = { userId: 4, rol: RolUsuario.MOSTRADOR, tiendaId: 5 };

describe('EstacionGuard', () => {
  it('una ruta sin la marca no se toca (las lecturas siguen abiertas)', async () => {
    const { guard, ctx, prisma } = crear({ exige: false });
    await expect(guard.canActivate(ctx(cajero))).resolves.toBe(true);
    expect(prisma.ventanilla.findFirst).not.toHaveBeenCalled();
  });

  it('cajero CON ventanilla puede atender', async () => {
    const { guard, ctx } = crear({ ventanilla: true });
    await expect(guard.canActivate(ctx(cajero))).resolves.toBe(true);
  });

  it('cajero SIN ventanilla (no eligió, o la liberó): 403', async () => {
    const { guard, ctx } = crear({ ventanilla: false });
    await expect(guard.canActivate(ctx(cajero))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(cajero))).rejects.toThrow(/elige una ventanilla/i);
  });

  it('operador CON mostrador puede atender', async () => {
    const { guard, ctx } = crear({ mostrador: true });
    await expect(guard.canActivate(ctx(operador))).resolves.toBe(true);
  });

  it('operador SIN mostrador y la tienda los tiene: 403 que pide elegir', async () => {
    const { guard, ctx } = crear({ mostrador: false, mostradoresEnTienda: 3 });
    await expect(guard.canActivate(ctx(operador))).rejects.toThrow(/elige tu mostrador/i);
  });

  it('operador SIN mostrador y la tienda NO tiene ninguno: ya no hay modo genérico', async () => {
    const { guard, ctx } = crear({ mostrador: false, mostradoresEnTienda: 0 });
    await expect(guard.canActivate(ctx(operador))).rejects.toThrow(/no tiene mostradores/i);
  });

  it('ADMIN queda exento (soporte y pruebas)', async () => {
    const { guard, ctx } = crear({});
    await expect(guard.canActivate(ctx({ userId: 1, rol: RolUsuario.ADMIN }))).resolves.toBe(true);
  });

  it('otros roles no se ven afectados', async () => {
    const { guard, ctx } = crear({});
    await expect(guard.canActivate(ctx({ userId: 9, rol: RolUsuario.BODEGA }))).resolves.toBe(true);
  });
});
