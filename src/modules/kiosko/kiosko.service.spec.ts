import { createHash } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EstadoKiosko, RolUsuario } from '@prisma/client';
import { KioskoService, type ActorKiosko } from './kiosko.service';
import { calcularSaludKiosko } from './kiosko-salud';

/**
 * Cubre el device token (el bug que previenen: que el header `X-Kiosko-Id` solo, sin token, permita crear pedidos
 * con `canalOrigen=KIOSKO`, porque el kioskoId es SERIAL y enumerable) y, desde oct 2026, el alta con nombre
 * automático, el alcance del GERENTE (solo su tienda) y el latido que devuelve la identidad del servidor.
 */
describe('KioskoService — device token', () => {
  // SHA-256 de un token arbitrario conocido. Lo calculamos aquí para no acoplar el test al generador; lo que
  // importa es que el servicio haga matching constante-tiempo entre hashDado y hashGuardado.
  const tokenPlano = 'token-de-prueba-1234567890abcdefghij';
  const hashDelToken = createHash('sha256').update(tokenPlano).digest('hex');

  const crearKioskoMock = (
    kiosko: {
      id: number;
      tiendaId: number;
      estado: EstadoKiosko;
      deviceTokenHash: string | null;
    } | null,
  ) => {
    const prisma = {
      kiosko: {
        findUnique: jest.fn(async () => kiosko),
      },
    };
    return { svc: new KioskoService(prisma as never), prisma };
  };

  describe('validarDeviceToken()', () => {
    it('rechaza si el kiosko está INACTIVO', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.INACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceToken(1, tokenPlano)).resolves.toBe(false);
    });

    it('rechaza si el kiosko no tiene deviceTokenHash (legacy)', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: null,
      });
      await expect(svc.validarDeviceToken(1, tokenPlano)).resolves.toBe(false);
    });

    it('rechaza si el kiosko no existe', async () => {
      const { svc } = crearKioskoMock(null);
      await expect(svc.validarDeviceToken(99, tokenPlano)).resolves.toBe(false);
    });

    it('rechaza si no llega token en el header', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceToken(1, undefined)).resolves.toBe(false);
      await expect(svc.validarDeviceToken(1, '')).resolves.toBe(false);
    });

    it('rechaza token incorrecto con comparación constante-tiempo', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      const tokenIncorrecto = 'token-incorrecto-aaaaaaaaaaaaaaa';
      await expect(svc.validarDeviceToken(1, tokenIncorrecto)).resolves.toBe(false);
    });

    it('acepta token correcto', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceToken(1, tokenPlano)).resolves.toBe(true);
    });
  });

  // El booleano colapsaba tres causas que el frontend necesita separar:
  // "la tablet no mandó token", "mandó uno inválido" y "el admin apagó el
  // kiosko". Las dos primeras son 401; la tercera es 409. Sin esta
  // distinción se le mostraba "token inválido" a un operador cuyo kiosko
  // simplemente estaba desactivado.
  describe('validarDeviceTokenConMotivo()', () => {
    it('sin token → SIN_TOKEN', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceTokenConMotivo(1, undefined)).resolves.toEqual({
        valido: false,
        motivo: 'SIN_TOKEN',
      });
    });

    it('token que no coincide → TOKEN_INVALIDO', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(
        svc.validarDeviceTokenConMotivo(1, 'token-incorrecto-aaaaaaaaaaaaaaa'),
      ).resolves.toEqual({ valido: false, motivo: 'TOKEN_INVALIDO' });
    });

    it('kiosko INACTIVO con token correcto → KIOSKO_INACTIVO (409, no 401)', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.INACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceTokenConMotivo(1, tokenPlano)).resolves.toEqual({
        valido: false,
        motivo: 'KIOSKO_INACTIVO',
      });
    });

    it('kiosko inexistente → TOKEN_INVALIDO (no revela que no existe)', async () => {
      const { svc } = crearKioskoMock(null);
      await expect(svc.validarDeviceTokenConMotivo(99, tokenPlano)).resolves.toEqual({
        valido: false,
        motivo: 'TOKEN_INVALIDO',
      });
    });

    it('kiosko INACTIVO con token INCORRECTO → TOKEN_INVALIDO', async () => {
      // El token se verifica ANTES de revelar el estado: un atacante que
      // enumera IDs no puede usar el código de respuesta como oráculo de
      // qué kioskos existen y están activos.
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.INACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(
        svc.validarDeviceTokenConMotivo(1, 'token-incorrecto-aaaaaaaaaaaaaaa'),
      ).resolves.toEqual({ valido: false, motivo: 'TOKEN_INVALIDO' });
    });

    it('token correcto en kiosko ACTIVO → válido sin motivo', async () => {
      const { svc } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      await expect(svc.validarDeviceTokenConMotivo(1, tokenPlano)).resolves.toEqual({
        valido: true,
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
const admin: ActorKiosko = { userId: 1, rol: RolUsuario.ADMIN };
const gerente = (tiendaId: number | null = 3): ActorKiosko => ({
  userId: 9,
  rol: RolUsuario.GERENTE,
  tiendaId,
});

function crearConPrisma(
  existentes: Array<{ nombre: string }> = [],
  kioskoDeId: Record<string, unknown> | null = null,
) {
  const create = jest.fn(async (args: any) => ({ id: 42, ...args.data }));
  const update = jest.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
  const prisma = {
    tienda: { findFirst: jest.fn().mockResolvedValue({ id: 3, activa: true }) },
    kiosko: {
      findMany: jest.fn().mockResolvedValue(existentes),
      findUnique: jest.fn().mockResolvedValue(kioskoDeId),
      findUniqueOrThrow: jest.fn().mockResolvedValue(kioskoDeId),
      create,
      update,
    },
  };
  return { svc: new KioskoService(prisma as never), prisma, create, update };
}

describe('KioskoService.crear — el sistema pone el nombre', () => {
  it('el primer kiosko de una tienda es "Kiosko 1": ACTIVO y SIN token (lo entrega el emparejamiento)', async () => {
    const { svc, create } = crearConPrisma([]);
    await svc.crear(admin, { tiendaId: 3 });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tiendaId: 3, nombre: 'Kiosko 1', estado: EstadoKiosko.ACTIVO });
    expect(data).not.toHaveProperty('deviceTokenHash');
  });

  it('el siguiente número libre, aunque haya huecos o nombres de otra forma', async () => {
    const { svc, create } = crearConPrisma([
      { nombre: 'Kiosko 1' },
      { nombre: 'Kiosko 4' },
      { nombre: 'Kiosko Entrada' },
      { nombre: 'kiosko 9 viejo' },
    ]);
    await svc.crear(admin, { tiendaId: 3 });
    expect(create.mock.calls[0][0].data.nombre).toBe('Kiosko 5');
  });

  it('guarda la ubicación recortada, y vacía es null', async () => {
    const a = crearConPrisma([]);
    await a.svc.crear(admin, { tiendaId: 3, ubicacion: '  Entrada  ' });
    expect(a.create.mock.calls[0][0].data.ubicacion).toBe('Entrada');
    const b = crearConPrisma([]);
    await b.svc.crear(admin, { tiendaId: 3, ubicacion: '   ' });
    expect(b.create.mock.calls[0][0].data.ubicacion).toBeNull();
  });

  it('si dos altas chocan por el mismo número, reintenta con el siguiente', async () => {
    const { svc, create, prisma } = crearConPrisma([]);
    create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.kiosko.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ nombre: 'Kiosko 1' }]);
    await svc.crear(admin, { tiendaId: 3 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].data.nombre).toBe('Kiosko 2');
  });

  it('un error que no es de unicidad NO se reintenta', async () => {
    const { svc, create } = crearConPrisma([]);
    create.mockRejectedValue(new Error('se cayó la BD'));
    await expect(svc.crear(admin, { tiendaId: 3 })).rejects.toThrow('se cayó la BD');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('el ADMIN debe elegir tienda', async () => {
    const { svc } = crearConPrisma([]);
    await expect(svc.crear(admin, {})).rejects.toThrow(BadRequestException);
  });

  it('el GERENTE da de alta en SU tienda aunque no mande tienda', async () => {
    const { svc, create } = crearConPrisma([]);
    await svc.crear(gerente(3), {});
    expect(create.mock.calls[0][0].data.tiendaId).toBe(3);
  });

  it('el GERENTE que manda OTRA tienda recibe 403 y no se crea nada', async () => {
    const { svc, create } = crearConPrisma([]);
    await expect(svc.crear(gerente(3), { tiendaId: 5 })).rejects.toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it('un gerente sin tienda en el token no puede dar de alta (falla cerrado)', async () => {
    const { svc } = crearConPrisma([]);
    await expect(svc.crear(gerente(null), {})).rejects.toThrow(ForbiddenException);
  });
});

describe('KioskoService — el GERENTE solo toca los kioskos de su tienda', () => {
  const kiosko = { id: 7, tiendaId: 3, estado: EstadoKiosko.ACTIVO, nombre: 'Kiosko 1' };

  it('listar acota a su tienda aunque pida otra con ?tiendaId=', async () => {
    const { svc, prisma } = crearConPrisma();
    prisma.kiosko.findMany.mockResolvedValue([]);
    await svc.listar(gerente(3), { tiendaId: 5 });
    expect(prisma.kiosko.findMany.mock.calls[0][0].where).toMatchObject({ tiendaId: 3 });
  });

  it('el ADMIN sin filtro ve todas las tiendas', async () => {
    const { svc, prisma } = crearConPrisma();
    prisma.kiosko.findMany.mockResolvedValue([]);
    await svc.listar(admin);
    expect(prisma.kiosko.findMany.mock.calls[0][0].where).toEqual({});
  });

  it.each([
    ['actualizar', (s: KioskoService) => s.actualizar(7, { ubicacion: 'x' }, gerente(5))],
    ['desvincular', (s: KioskoService) => s.desvincular(7, gerente(5))],
  ])(
    '%s un kiosko de OTRA tienda es 404 (no revela que existe) y no escribe',
    async (_n, accion) => {
      const { svc, update } = crearConPrisma([], kiosko);
      await expect(accion(svc)).rejects.toThrow(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('en SU tienda sí puede, y el ADMIN en cualquiera', async () => {
    const a = crearConPrisma([], kiosko);
    await a.svc.desvincular(7, gerente(3));
    expect(a.update).toHaveBeenCalled();
    const b = crearConPrisma([], kiosko);
    await b.svc.desvincular(7, admin);
    expect(b.update).toHaveBeenCalled();
  });

  it('desvincular borra el token (la tablet vuelve sola a emparejarse) y NO borra el kiosko', async () => {
    const { svc, update } = crearConPrisma([], kiosko);
    await svc.desvincular(7, gerente(3));
    expect(update.mock.calls[0][0].data).toEqual({
      deviceTokenHash: null,
      deviceTokenCreadoAt: null,
    });
  });

  it('apagar anota quién y cuándo; encender lo borra; el nombre y la tienda no se editan', async () => {
    const off = crearConPrisma([], kiosko);
    await off.svc.actualizar(7, { estado: EstadoKiosko.INACTIVO }, gerente(3));
    expect(off.update.mock.calls[0][0].data).toMatchObject({
      estado: EstadoKiosko.INACTIVO,
      desactivadoPor: { connect: { id: 9 } },
    });
    const on = crearConPrisma([], { ...kiosko, estado: EstadoKiosko.INACTIVO });
    await on.svc.actualizar(7, { estado: EstadoKiosko.ACTIVO }, gerente(3));
    expect(on.update.mock.calls[0][0].data).toMatchObject({
      estado: EstadoKiosko.ACTIVO,
      desactivadoAt: null,
      desactivadoPor: { disconnect: true },
    });
    expect(Object.keys(on.update.mock.calls[0][0].data)).not.toContain('nombre');
    expect(Object.keys(on.update.mock.calls[0][0].data)).not.toContain('tiendaId');
  });
});

describe('KioskoService.heartbeat — la identidad que dice el servidor', () => {
  const fila = {
    id: 7,
    ultimoHeartbeat: new Date('2026-10-19T12:00:00Z'),
    estado: EstadoKiosko.ACTIVO,
    nombre: 'Kiosko 2',
    tiendaId: 3,
    tienda: { nombre: 'Hermosillo Centro' },
  };

  function crear(estado: EstadoKiosko = EstadoKiosko.ACTIVO) {
    const prisma = {
      kiosko: {
        findUnique: jest.fn().mockResolvedValue({ id: 7, estado }),
        update: jest.fn().mockResolvedValue(fila),
      },
    };
    return { svc: new KioskoService(prisma as never), prisma };
  }

  it('responde su nombre, su tienda y su estado', async () => {
    const { svc } = crear();
    expect(await svc.heartbeat(7)).toEqual({
      kioskoId: 7,
      ultimoHeartbeat: fila.ultimoHeartbeat,
      estado: EstadoKiosko.ACTIVO,
      nombre: 'Kiosko 2',
      tiendaId: 3,
      tiendaNombre: 'Hermosillo Centro',
    });
  });

  it('pide solo lo necesario a la BD (nada del hash del token)', async () => {
    const { svc, prisma } = crear();
    await svc.heartbeat(7);
    const select = prisma.kiosko.update.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual(
      ['estado', 'id', 'nombre', 'tienda', 'tiendaId', 'ultimoHeartbeat'].sort(),
    );
  });

  it('un kiosko apagado no late (el controller ya lo rechaza antes con 409)', async () => {
    const { svc } = crear(EstadoKiosko.INACTIVO);
    await expect(svc.heartbeat(7)).rejects.toThrow(BadRequestException);
  });
});

describe('calcularSaludKiosko — "pendiente de instalar" se deduce, ya no es un estado', () => {
  const ahora = Date.parse('2026-10-19T12:00:00Z');
  const base = {
    estado: 'ACTIVO',
    ultimoHeartbeat: null,
    primerConexionAt: null,
    desactivadoAt: null,
    deviceTokenHash: null,
  };

  it('recién dado de alta (ACTIVO, sin token, nunca vinculado): pendiente de instalar', () => {
    expect(calcularSaludKiosko(base, ahora)).toBe('PENDIENTE_INSTALAR');
  });
  it('vinculado pero aún sin latir: pendiente de instalar', () => {
    expect(
      calcularSaludKiosko(
        { ...base, deviceTokenHash: 'h', primerConexionAt: new Date(ahora) },
        ahora,
      ),
    ).toBe('PENDIENTE_INSTALAR');
  });
  it('tuvo tablet y la desvincularon: sin credencial (hay que vincular otra)', () => {
    expect(calcularSaludKiosko({ ...base, primerConexionAt: new Date(ahora - 1e9) }, ahora)).toBe(
      'SIN_CREDENCIAL',
    );
  });
  it('apagado por el admin o gerente: apagado, no caído, aunque no lata', () => {
    expect(calcularSaludKiosko({ ...base, estado: 'INACTIVO' }, ahora)).toBe('APAGADO_ADMIN');
  });
  it('late con normalidad / con retraso / caído', () => {
    const k = { ...base, deviceTokenHash: 'h', primerConexionAt: new Date(ahora - 1e9) };
    expect(calcularSaludKiosko({ ...k, ultimoHeartbeat: new Date(ahora - 30_000) }, ahora)).toBe(
      'SANA',
    );
    expect(
      calcularSaludKiosko({ ...k, ultimoHeartbeat: new Date(ahora - 5 * 60_000) }, ahora),
    ).toBe('LATIDO_LENTO');
    expect(
      calcularSaludKiosko({ ...k, ultimoHeartbeat: new Date(ahora - 11 * 60_000) }, ahora),
    ).toBe('CAIDA');
  });
});
