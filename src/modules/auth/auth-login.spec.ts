import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RolUsuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { LoginBloqueoService } from './login-bloqueo.service';
import { CuentaDesactivadaException } from './exceptions/cuenta-desactivada.exception';

/**
 * Oct 2026: el login que no delata nada. Cada caso fija una decisión de seguridad que un mock "feliz" no ve:
 *
 *  - un correo que NO existe paga el mismo `bcrypt.compare` que uno que sí (si no, el tiempo dice quién tiene cuenta);
 *  - "cuenta desactivada" solo se revela con la contraseña CORRECTA (antes lo decía a cualquiera que preguntara);
 *  - 10 fallos por cuenta bloquean con 429, cuenten o no con cuenta, sin tocar la BD y aunque llegue la clave buena.
 *
 * `bcrypt.compare` va envuelto (conserva el real) para poder contar cuántas veces se llama y con qué hash.
 */
jest.mock('bcrypt', () => {
  const real = jest.requireActual('bcrypt');
  return { ...real, compare: jest.fn(real.compare) };
});

const SECRET = 'prueba-de-login-con-un-secreto-de-mas-de-32-caracteres';
const CLAVE = 'Clave-correcta1';
const HASH_REAL = bcrypt.hashSync(CLAVE, 4);

const compare = bcrypt.compare as unknown as jest.Mock;

function usuarioBd(extra: Record<string, unknown> = {}) {
  return {
    id: 7,
    email: 'ana@tienda.com',
    password: HASH_REAL,
    nombre: 'Ana',
    apellido: null,
    telefono: null,
    rol: RolUsuario.CLIENTE,
    tiendaId: null,
    activo: true,
    deletedAt: null,
    ...extra,
  };
}

function armar(usuarios: Record<string, ReturnType<typeof usuarioBd>> = {}) {
  const prisma = {
    usuario: {
      findUnique: jest.fn(
        async ({ where }: { where: { email: string } }) => usuarios[where.email] ?? null,
      ),
      update: jest.fn(async ({ data }: { data: object }) => ({ email: 'ana@tienda.com', ...data })),
    },
    refreshToken: {
      create: jest.fn(async () => ({ id: 1 })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    passwordResetToken: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const config = {
    get: (k: string) => ({ 'app.jwtExpiresIn': '1h', 'app.jwtRefreshExpiresIn': '7d' })[k],
  } as unknown as ConfigService;
  const svc = new AuthService(
    prisma as never,
    new JwtService({ secret: SECRET }),
    config,
    {} as never,
    {} as never,
    { entro: jest.fn() } as never,
    new LoginBloqueoService(),
  );
  return { svc, prisma };
}

const intentar = (svc: AuthService, email: string, password: string) =>
  svc.login({ email, password }).then(
    () => 'ok' as const,
    (e: unknown) => e,
  );

beforeEach(() => compare.mockClear());

describe('login: el correo que no existe cuesta lo mismo que el que sí', () => {
  it('corre bcrypt.compare con un hash de señuelo válido y rechaza con el mensaje genérico', async () => {
    const { svc } = armar();
    const e = await intentar(svc, 'nadie@tienda.com', 'lo-que-sea-1');

    expect(e).toBeInstanceOf(UnauthorizedException);
    expect((e as UnauthorizedException).message).toBe('Credenciales inválidas');
    expect(compare).toHaveBeenCalledTimes(1);
    const [claveEnviada, hash] = compare.mock.calls[0];
    expect(claveEnviada).toBe('lo-que-sea-1');
    expect(hash).toMatch(/^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/); // bcrypt válido, mismo coste que las cuentas reales
  });

  it('el rechazo de un correo inexistente es indistinguible del de una contraseña equivocada', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });
    const inexistente = (await intentar(
      svc,
      'nadie@tienda.com',
      'Otra-clave-1',
    )) as UnauthorizedException;
    const mala = (await intentar(svc, 'ana@tienda.com', 'Otra-clave-1')) as UnauthorizedException;

    expect(inexistente.constructor).toBe(mala.constructor);
    expect(inexistente.getResponse()).toEqual(mala.getResponse());
    expect(compare).toHaveBeenCalledTimes(2);
  });
});

describe('login: el estado de la cuenta solo se revela tras la contraseña correcta', () => {
  it('desactivada + contraseña MALA → genérico, sin `codigo` (no confirma que la cuenta existe)', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd({ activo: false }) });
    const e = await intentar(svc, 'ana@tienda.com', 'Otra-clave-1');

    expect(e).toBeInstanceOf(UnauthorizedException);
    expect(e).not.toBeInstanceOf(CuentaDesactivadaException);
    expect((e as UnauthorizedException).getResponse()).not.toHaveProperty('codigo');
  });

  it('desactivada + contraseña CORRECTA → USUARIO_DESACTIVADO (el frontend muestra "contacta a soporte")', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd({ activo: false }) });
    const e = await intentar(svc, 'ana@tienda.com', CLAVE);

    expect(e).toBeInstanceOf(CuentaDesactivadaException);
    expect((e as CuentaDesactivadaException).getResponse()).toMatchObject({
      codigo: 'USUARIO_DESACTIVADO',
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled(); // no hay sesión
  });

  it('dada de baja (`deletedAt`) aunque `activo` siga en true → también USUARIO_DESACTIVADO', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd({ deletedAt: new Date() }) });
    expect(await intentar(svc, 'ana@tienda.com', CLAVE)).toBeInstanceOf(CuentaDesactivadaException);
  });

  it('cuenta activa + contraseña correcta → sesión', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    const r = await svc.login({ email: 'ana@tienda.com', password: CLAVE });

    expect(r.user.email).toBe('ana@tienda.com');
    expect(r.accessToken).toBeTruthy();
    expect(prisma.usuario.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastLogin: expect.any(Date) } }),
    );
  });
});

describe('login: bloqueo por cuenta tras 10 fallos', () => {
  const fallar = async (svc: AuthService, email: string, veces: number) => {
    for (let i = 0; i < veces; i++) await intentar(svc, email, 'Equivocada-1');
  };

  it('el intento 11 recibe 429, ni consulta la BD, y rechaza incluso la contraseña CORRECTA', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    await fallar(svc, 'ana@tienda.com', 10);
    prisma.usuario.findUnique.mockClear();
    compare.mockClear();

    const e = (await intentar(svc, 'ana@tienda.com', CLAVE)) as HttpException;
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(429);
    expect(e.getResponse()).toMatchObject({
      statusCode: 429,
      reintentarEnSegundos: expect.any(Number),
      message: expect.stringMatching(
        /^Demasiados intentos fallidos\. Vuelve a intentarlo en \d+ minutos?\.$/,
      ),
    });
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled(); // no gasta bcrypt en quien ya está bloqueado
  });

  it('9 fallos no bloquean todavía', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });
    await fallar(svc, 'ana@tienda.com', 9);
    expect(await svc.login({ email: 'ana@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });

  it('un acierto antes del tope reinicia la cuenta', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });
    await fallar(svc, 'ana@tienda.com', 9);
    await svc.login({ email: 'ana@tienda.com', password: CLAVE });
    await fallar(svc, 'ana@tienda.com', 9);
    expect(await svc.login({ email: 'ana@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });

  it('un correo que NO existe se bloquea igual (el bloqueo no es un oráculo de qué correos tienen cuenta)', async () => {
    const { svc } = armar();
    await fallar(svc, 'nadie@tienda.com', 10);
    const e = (await intentar(svc, 'nadie@tienda.com', 'Equivocada-1')) as HttpException;
    expect(e.getStatus()).toBe(429);
  });

  it('es POR CUENTA: bloquear a una no impide entrar a otra', async () => {
    const { svc } = armar({
      'ana@tienda.com': usuarioBd(),
      'luis@tienda.com': usuarioBd({ id: 8, email: 'luis@tienda.com' }),
    });
    await fallar(svc, 'ana@tienda.com', 10);
    expect(await svc.login({ email: 'luis@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });

  it('mayúsculas y espacios no reinician la cuenta ("ANA@..." cuenta como "ana@...")', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });
    for (let i = 0; i < 5; i++) await intentar(svc, 'ana@tienda.com', 'Equivocada-1');
    for (let i = 0; i < 5; i++) await intentar(svc, 'ANA@Tienda.com', 'Equivocada-1');
    const e = (await intentar(svc, 'ana@tienda.com', CLAVE)) as HttpException;
    expect(e.getStatus()).toBe(429);
  });

  it('restablecer la contraseña con el token del correo libera el bloqueo', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    await fallar(svc, 'ana@tienda.com', 10);
    expect(((await intentar(svc, 'ana@tienda.com', CLAVE)) as HttpException).getStatus()).toBe(429);

    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 7,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await svc.resetearPassword({ token: 'token-del-correo', newPassword: 'Nueva-clave-2' });

    expect(await svc.login({ email: 'ana@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });

  it('restablecer la contraseña cierra TODAS las sesiones abiertas (la de un ladrón incluida)', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 1,
      usuarioId: 7,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await svc.resetearPassword({ token: 'token-del-correo', newPassword: 'Nueva-clave-2' });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { usuarioId: 7, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('un token de restablecimiento inválido NO libera nada', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    await fallar(svc, 'ana@tienda.com', 10);
    prisma.passwordResetToken.findUnique.mockResolvedValue(null);
    await svc.resetearPassword({ token: 'inventado', newPassword: 'Nueva-clave-2' });

    expect(((await intentar(svc, 'ana@tienda.com', CLAVE)) as HttpException).getStatus()).toBe(429);
  });
});

describe('login: el bloqueo aguanta ráfagas y errores del servidor', () => {
  it('RÁFAGA: 30 intentos simultáneos con una contraseña equivocada → solo 10 gastan un bcrypt, el resto recibe 429', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });

    const r = await Promise.all(
      Array.from({ length: 30 }, () => intentar(svc, 'ana@tienda.com', 'Equivocada-1')),
    );

    // Antes el chequeo iba antes de esperar a la BD y a bcrypt y la anotación después: las 30 pasaban el chequeo
    // (nadie había anotado todavía) y daban 30 adivinanzas antes de que el bloqueo entrara.
    expect(compare).toHaveBeenCalledTimes(10);
    expect(r.filter((e) => e instanceof UnauthorizedException)).toHaveLength(10);
    expect(
      r.filter((e) => e instanceof HttpException && (e as HttpException).getStatus() === 429),
    ).toHaveLength(20);
  });

  it('un fallo de la BD no es una contraseña equivocada: 10 caídas seguidas NO bloquean la cuenta', async () => {
    const { svc, prisma } = armar({ 'ana@tienda.com': usuarioBd() });
    for (let i = 0; i < 12; i++) {
      prisma.usuario.findUnique.mockRejectedValueOnce(new Error('BD caída'));
      expect(await intentar(svc, 'ana@tienda.com', CLAVE)).toBeInstanceOf(Error);
    }
    // La BD volvió: la contraseña buena entra, no hay 429.
    expect(await svc.login({ email: 'ana@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });

  it('un acierto durante una ráfaga libera la cuenta', async () => {
    const { svc } = armar({ 'ana@tienda.com': usuarioBd() });
    for (let i = 0; i < 6; i++) await intentar(svc, 'ana@tienda.com', 'Equivocada-1');
    await svc.login({ email: 'ana@tienda.com', password: CLAVE });
    for (let i = 0; i < 9; i++) await intentar(svc, 'ana@tienda.com', 'Equivocada-1');
    expect(await svc.login({ email: 'ana@tienda.com', password: CLAVE })).toHaveProperty(
      'accessToken',
    );
  });
});
