import { UnauthorizedException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { JwtStrategy } from './jwt.strategy';

/**
 * Oct 2026 (Fase 0 de pagos por transferencia): el rol sale de la BD, no del token.
 *
 * Antes `rol` se copiaba del token firmado: cambiarle el rol a un empleado (o quitarle
 * ADMIN) no surtía efecto hasta que expiraba su access token. `tiendaId` ya salía de la
 * BD; `rol` era el campo que quedaba atrás.
 */
function crear(usuario: Record<string, unknown> | null) {
  const prisma = { usuario: { findUnique: jest.fn().mockResolvedValue(usuario) } };
  const config = { get: jest.fn().mockReturnValue('secreto-de-prueba') };
  return new JwtStrategy(config as never, prisma as never);
}

const payload = { sub: 7, email: 'a@test.local', rol: 'ADMIN' };
const base = {
  id: 7,
  activo: true,
  deletedAt: null,
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 3,
  nombre: 'Ana',
};

describe('JwtStrategy.validate', () => {
  it('toma el rol de la BD aunque el token diga otra cosa', async () => {
    const user = await crear(base).validate({} as never, payload);
    expect(user.rol).toBe(RolUsuario.MOSTRADOR);
    expect(user).toMatchObject({ userId: 7, tiendaId: 3, nombre: 'Ana' });
  });

  // PLAN-ADMIN-MULTITIENDA §4.5.3: el nombre del `UserContext` es el que se escribe en el historial, en
  // los avisos y en los eventos. Resolverlo AQUÍ (y no en los ~16 sitios que escriben `usuario.nombre`)
  // garantiza que ninguna acción del ADMIN se atribuya sin decir que fue un administrador.
  it('al ADMIN se le agrega su rol al nombre: sus acciones no se confunden con las de un empleado', async () => {
    const user = await crear({ ...base, rol: RolUsuario.ADMIN, nombre: 'Fernando' }).validate(
      {} as never,
      payload,
    );
    expect(user.nombre).toBe('Fernando (Administrador)');
  });

  it('un empleado conserva su nombre tal cual', async () => {
    const user = await crear(base).validate({} as never, payload);
    expect(user.nombre).toBe('Ana');
  });

  it('un usuario degradado de ADMIN pierde el permiso en la siguiente petición', async () => {
    const user = await crear({ ...base, rol: RolUsuario.CAJERO }).validate({} as never, payload);
    expect(user.rol).not.toBe('ADMIN');
  });

  it('rechaza al usuario inexistente, inactivo o dado de baja', async () => {
    await expect(crear(null).validate({} as never, payload)).rejects.toThrow(UnauthorizedException);
    await expect(crear({ ...base, activo: false }).validate({} as never, payload)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      crear({ ...base, deletedAt: new Date() }).validate({} as never, payload),
    ).rejects.toThrow(UnauthorizedException);
  });
});

/**
 * El refresh token (7 días, lleva `jti`) y el del QR del kiosko (5 min, lleva `kind`) se firman con el MISMO secreto y
 * llevan `sub`. Sin esto la estrategia los aceptaba como `Authorization: Bearer`, y ese uso no pasa por la tabla
 * `refresh_tokens`: ni la rotación, ni el logout, ni `revocarFamilia` lo frenaban.
 */
describe('JwtStrategy.validate: solo acepta tokens de ACCESO', () => {
  const sinBd = () => {
    const findUnique = jest.fn().mockResolvedValue(base);
    const config = { get: jest.fn().mockReturnValue('secreto-de-prueba') };
    const estrategia = new JwtStrategy(config as never, { usuario: { findUnique } } as never);
    return { estrategia, findUnique };
  };

  it('un refresh token (con `jti`) NO sirve como Bearer, y se rechaza sin consultar la BD', async () => {
    const { estrategia, findUnique } = sinBd();
    await expect(
      estrategia.validate({} as never, { ...payload, jti: 'a-uuid' } as never),
    ).rejects.toThrow(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('el token del QR del kiosko (con `kind`) tampoco', async () => {
    const { estrategia, findUnique } = sinBd();
    await expect(
      estrategia.validate({} as never, { sub: 7, kind: 'kiosk', tiendaId: 3 } as never),
    ).rejects.toThrow(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('el token de acceso (sin `jti` ni `kind`) sí pasa', async () => {
    const { estrategia } = sinBd();
    await expect(estrategia.validate({} as never, payload)).resolves.toMatchObject({ userId: 7 });
  });
});
