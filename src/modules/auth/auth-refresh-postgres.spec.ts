import 'dotenv/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RolUsuario } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { LoginBloqueoService } from './login-bloqueo.service';

/**
 * Oct 2026 contra PostgreSQL REAL: la rotación del refresh token y el cierre de sesión por dispositivo.
 *
 * Lo que importa y un mock de Prisma no puede comprobar: el reclamo `updateMany … where revokedAt is null` y la
 * emisión del sucesor viven en UNA transacción y los candados de fila ordenan a quien llega segundo. Antes la
 * rotación leía `revokedAt` y marcaba el token usado DESPUÉS de emitir el par nuevo: dos refresh simultáneos con el
 * mismo token pasaban ambos y bifurcaban la familia; y la carrera legítima (dos pestañas) destruía la sesión.
 */
jest.setTimeout(60_000);

const SECRET = 'prueba-de-auth-con-un-secreto-de-mas-de-32-caracteres';
const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const usuarioIds: number[] = [];

const config = {
  get: (k: string) =>
    ({ 'app.jwtSecret': SECRET, 'app.jwtExpiresIn': '1h', 'app.jwtRefreshExpiresIn': '7d' })[k],
} as unknown as ConfigService;
const bodegaPresencia = {
  entro: jest.fn(),
  salio: jest.fn().mockResolvedValue(undefined),
  haySesionViva: jest.fn().mockResolvedValue(false),
};

const svc = () =>
  new AuthService(
    prisma as never,
    new JwtService({ secret: SECRET }),
    config,
    {} as never,
    {} as never,
    bodegaPresencia as never,
    new LoginBloqueoService(),
  );

async function usuario(nombre: string, extra: { deletedAt?: Date } = {}) {
  const u = await prisma.usuario.create({
    data: {
      email: `${nombre}-${suffix}@test.local`,
      password: bcrypt.hashSync('clave-de-prueba', 4),
      nombre,
      rol: RolUsuario.CLIENTE,
      ...extra,
    },
  });
  usuarioIds.push(u.id);
  return u;
}

/** Inicia sesión y devuelve el refresh token (el servicio lo devuelve; el CONTROLLER es quien lo quita del cuerpo). */
async function entrar(email: string) {
  return svc().login({ email, password: 'clave-de-prueba' });
}

const filas = (usuarioId: number) =>
  prisma.refreshToken.findMany({ where: { usuarioId }, orderBy: { id: 'asc' } });

afterAll(async () => {
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } }); // cascade a refresh_tokens
  await prisma.$disconnect();
});

describe('refresh token: rotación', () => {
  it('rota: el sucesor es de la MISMA familia y el usado queda revocado apuntando a él', async () => {
    const u = await usuario('rota');
    const a = await entrar(u.email);
    const b = await svc().refreshToken({ refreshToken: a.refreshToken });

    expect(b.refreshToken).not.toBe(a.refreshToken);
    const [viejo, nuevo] = await filas(u.id);
    expect(nuevo.familyId).toBe(viejo.familyId);
    expect(viejo.revokedAt).not.toBeNull();
    expect(viejo.replacedBy).toBe(nuevo.id);
    expect(nuevo.revokedAt).toBeNull();
  });

  it('la respuesta lleva el user y expiresIn (el cliente reconstruye la sesión solo con la cookie)', async () => {
    const u = await usuario('reconstruye');
    const a = await entrar(u.email);
    const b = await svc().refreshToken({ refreshToken: a.refreshToken });
    expect(b.user).toMatchObject({ id: u.id, email: u.email, rol: RolUsuario.CLIENTE });
    expect(b.expiresIn).toBe(3600);
  });

  it('CARRERA: dos refresh simultáneos con el mismo token NO destruyen la sesión ni bifurcan en silencio', async () => {
    const u = await usuario('carrera');
    const a = await entrar(u.email);

    const [r1, r2] = await Promise.all([
      svc().refreshToken({ refreshToken: a.refreshToken }),
      svc().refreshToken({ refreshToken: a.refreshToken }),
    ]);

    expect(r1.accessToken).toBeTruthy();
    expect(r2.accessToken).toBeTruthy();
    const todas = await filas(u.id);
    // Misma familia, ninguna revocada salvo la original (la familia NO se destruyó).
    expect(new Set(todas.map((t) => t.familyId)).size).toBe(1);
    expect(todas.filter((t) => t.revokedAt === null)).toHaveLength(2);
    // Y cualquiera de los dos sucesores sigue siendo utilizable.
    await expect(svc().refreshToken({ refreshToken: r1.refreshToken })).resolves.toBeTruthy();
  });

  it('CARRERA ×5: cinco refresh a la vez con el mismo token, ninguno falla', async () => {
    const u = await usuario('carrera5');
    const a = await entrar(u.email);
    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () => svc().refreshToken({ refreshToken: a.refreshToken })),
    );
    expect(resultados.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    const todas = await filas(u.id);
    expect(todas.filter((t) => t.revokedAt === null)).toHaveLength(5);
  });

  it('REUTILIZACIÓN fuera de la ventana de gracia = robo: 401 y se revoca TODA la familia', async () => {
    const u = await usuario('robo');
    const a = await entrar(u.email);
    const b = await svc().refreshToken({ refreshToken: a.refreshToken });

    // El token viejo se rotó hace un minuto (fuera de los 10 s de gracia).
    await prisma.refreshToken.updateMany({
      where: { usuarioId: u.id, replacedBy: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // El sucesor legítimo también quedó invalidado.
    await expect(svc().refreshToken({ refreshToken: b.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((await filas(u.id)).every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('un token inexistente o mal firmado da 401', async () => {
    await expect(svc().refreshToken({ refreshToken: 'basura' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(svc().refreshToken({})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un usuario dado de baja lógica (deletedAt) NO puede renovar la sesión', async () => {
    const u = await usuario('baja');
    const a = await entrar(u.email);
    await prisma.usuario.update({ where: { id: u.id }, data: { deletedAt: new Date() } });
    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('logout por dispositivo', () => {
  it('un refresh en vuelo al cerrar sesión NO la resucita (la gracia es solo para tokens ROTADOS)', async () => {
    const u = await usuario('nores');
    const a = await entrar(u.email);
    await svc().logout(u.id, 'x', RolUsuario.CLIENTE, a.refreshToken);

    // Inmediatamente después (dentro de los 10 s): el token está revocado por logout, no rotado.
    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect((await filas(u.id)).every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('cierra SOLO este dispositivo: la sesión del otro (otra familia) sigue viva', async () => {
    const u = await usuario('dispositivos');
    const tablet = await entrar(u.email);
    const portatil = await entrar(u.email);

    await svc().logout(u.id, 'x', RolUsuario.CLIENTE, tablet.refreshToken);

    await expect(svc().refreshToken({ refreshToken: tablet.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(svc().refreshToken({ refreshToken: portatil.refreshToken })).resolves.toBeTruthy();
  });

  it('sin cookie cae al valor seguro: revoca TODAS las sesiones del usuario', async () => {
    const u = await usuario('sincookie');
    const a = await entrar(u.email);
    const b = await entrar(u.email);
    await svc().logout(u.id, 'x', RolUsuario.CLIENTE, undefined);
    for (const t of [a, b]) {
      await expect(svc().refreshToken({ refreshToken: t.refreshToken })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('un refresh token AJENO no sirve para cerrar la sesión de otro: cae al valor seguro del que llama', async () => {
    const yo = await usuario('yo');
    const otro = await usuario('otro');
    const mio = await entrar(yo.email);
    const suyo = await entrar(otro.email);

    await svc().logout(yo.id, 'x', RolUsuario.CLIENTE, suyo.refreshToken);

    // Las suyas siguen vivas (no se revoca a ciegas por una cookie que no es del que llama)…
    await expect(svc().refreshToken({ refreshToken: suyo.refreshToken })).resolves.toBeTruthy();
    // …y las mías se revocaron todas (el valor seguro).
    await expect(svc().refreshToken({ refreshToken: mio.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('gracia: el token VIEJO no reabre una familia que el logout cerró', () => {
  it('T0 rotado a T1 y logout con T1: presentar T0 dentro de los 10 s da 401 y NO emite ninguna sesión nueva', async () => {
    const u = await usuario('graciaLogout');
    const t0 = await entrar(u.email);
    const t1 = await svc().refreshToken({ refreshToken: t0.refreshToken }); // T0 queda rotado (replacedBy = T1)
    await svc().logout(u.id, 'x', RolUsuario.CLIENTE, t1.refreshToken); // cierra la familia

    await expect(svc().refreshToken({ refreshToken: t0.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const todas = await filas(u.id);
    expect(todas).toHaveLength(2); // ningún sucesor nuevo
    expect(todas.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('sin logout de por medio la gracia sigue funcionando (dos pestañas): T0 rotado y presentado otra vez entra', async () => {
    const u = await usuario('graciaViva');
    const t0 = await entrar(u.email);
    await svc().refreshToken({ refreshToken: t0.refreshToken });
    await expect(svc().refreshToken({ refreshToken: t0.refreshToken })).resolves.toBeTruthy();
  });
});

describe('cambiar la contraseña cierra las demás sesiones', () => {
  const NUEVA = 'Clave-nueva-9';

  it('conserva la sesión de ESTE dispositivo (la cookie) y cierra la del resto', async () => {
    const u = await usuario('cambioClave');
    const tablet = await entrar(u.email);
    const portatil = await entrar(u.email);

    await svc().changePassword(
      u.id,
      { oldPassword: 'clave-de-prueba', newPassword: NUEVA },
      tablet.refreshToken,
    );

    await expect(svc().refreshToken({ refreshToken: tablet.refreshToken })).resolves.toBeTruthy();
    await expect(
      svc().refreshToken({ refreshToken: portatil.refreshToken }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sin cookie cae al valor seguro: cierra TODAS', async () => {
    const u = await usuario('cambioSinCookie');
    const a = await entrar(u.email);
    await svc().changePassword(u.id, { oldPassword: 'clave-de-prueba', newPassword: NUEVA });
    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('con la contraseña actual equivocada no se cierra nada', async () => {
    const u = await usuario('cambioMal');
    const a = await entrar(u.email);
    await expect(
      svc().changePassword(u.id, { oldPassword: 'incorrecta', newPassword: NUEVA }, a.refreshToken),
    ).rejects.toBeInstanceOf(BadRequestException); // 400, no 401: el usuario SÍ está autenticado
    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).resolves.toBeTruthy();
  });
});

describe('logout y presencia de bodega', () => {
  beforeEach(() => bodegaPresencia.salio.mockClear());

  it('cerrar la sesión de un dispositivo con OTRA sesión viva NO saca al bodeguero de la TV', async () => {
    const u = await usuario('bodegaDosDisp');
    bodegaPresencia.haySesionViva.mockResolvedValueOnce(true);
    const a = await entrar(u.email);
    await svc().logout(u.id, 'x', RolUsuario.BODEGA, a.refreshToken);
    expect(bodegaPresencia.salio).not.toHaveBeenCalled();
  });

  it('cerrar la ÚLTIMA sesión viva sí lo saca y devuelve sus pedidos', async () => {
    const u = await usuario('bodegaUnica');
    bodegaPresencia.haySesionViva.mockResolvedValueOnce(false);
    const a = await entrar(u.email);
    await svc().logout(u.id, 'x', RolUsuario.BODEGA, a.refreshToken);
    expect(bodegaPresencia.salio).toHaveBeenCalledWith(u.id);
  });

  it('si la consulta de presencia falla, el logout igual termina (nunca impide cerrar sesión)', async () => {
    const u = await usuario('bodegaFalla');
    bodegaPresencia.haySesionViva.mockRejectedValueOnce(new Error('BD'));
    const a = await entrar(u.email);
    await expect(svc().logout(u.id, 'x', RolUsuario.BODEGA, a.refreshToken)).resolves.toMatchObject(
      { message: expect.any(String) },
    );
    await expect(svc().refreshToken({ refreshToken: a.refreshToken })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
