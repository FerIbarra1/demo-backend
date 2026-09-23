import { createHash, randomBytes } from 'crypto';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { KioskoService } from './kiosko.service';
import { EstadoKiosko } from '@prisma/client';

/**
 * Cubre la lógica de device token introducida en PR2 (kiosko-profesional).
 * El bug que estas pruebas previenen es que el header `X-Kiosko-Id` solo
 * (sin `X-Kiosko-Token`) permita crear pedidos con `canalOrigen=KIOSKO`,
 * ya que el kioskoId es SERIAL y enumerable.
 */
describe('KioskoService — device token (PR2)', () => {
  // SHA-256 de un token arbitrario conocido. Lo calculamos aquí para
  // no acoplar el test al generador; lo que nos importa es que el
  // servicio haga matching constante-tiempo entre hashDado y hashGuardado.
  const tokenPlano = 'token-de-prueba-1234567890abcdefghij';
  const hashDelToken = createHash('sha256').update(tokenPlano).digest('hex');

  const crearKioskoMock = (kiosko: {
    id: number;
    tiendaId: number;
    estado: EstadoKiosko;
    deviceTokenHash: string | null;
    desactivadoAt?: Date | null;
    primerConexionAt?: Date | null;
  } | null) => {
    const prisma = {
      kiosko: {
        findUnique: jest.fn(async (args: any) => {
          if (!kiosko) return null;
          // Si piden select deviceTokenHash/estado, devolvemos subset.
          if (args?.select && Object.keys(args.select).sort().join(',') === 'deviceTokenHash,estado') {
            return { deviceTokenHash: kiosko.deviceTokenHash, estado: kiosko.estado };
          }
          return kiosko;
        }),
        findFirst: jest.fn().mockResolvedValue(kiosko),
        create: jest.fn(async (args: any) => ({ id: 42, ...args.data })),
        update: jest.fn(async (args: any) => ({ id: 42, ...args.data })),
        findUniquePorTiendaNombre: jest.fn().mockResolvedValue(null),
      },
      tienda: { findFirst: jest.fn().mockResolvedValue({ id: 1, activa: true }) },
    };
    return { svc: new KioskoService(prisma as never), prisma };
  };

  describe('activar() genera device token', () => {
    it('devuelve deviceTokenPlain en claro una sola vez al activar', async () => {
      const { svc, prisma } = crearKioskoMock(null);
      const result = await svc.activar(
        { tiendaId: 1, nombre: 'Kiosko Test' },
        99 /* adminUserId */,
      );
      // El token se devuelve en el resultado de activar.
      expect(result).toHaveProperty('deviceTokenPlain');
      expect(typeof (result as any).deviceTokenPlain).toBe('string');
      expect((result as any).deviceTokenPlain.length).toBeGreaterThanOrEqual(40);
      // Se persiste hasheado (nunca en claro).
      const dataPersistida = prisma.kiosko.create.mock.calls[0][0].data;
      expect(dataPersistida.deviceTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(dataPersistida.deviceTokenHash).not.toBe((result as any).deviceTokenPlain);
      expect(dataPersistida.deviceTokenCreadoAt).toBeInstanceOf(Date);
    });
  });

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

  describe('regenerarDeviceToken()', () => {
    it('cambia el hash y devuelve el nuevo token en claro', async () => {
      const { svc, prisma } = crearKioskoMock({
        id: 1,
        tiendaId: 1,
        estado: EstadoKiosko.ACTIVO,
        deviceTokenHash: hashDelToken,
      });
      const { kiosko, deviceTokenPlain } = await svc.regenerarDeviceToken(1, 99);
      // Hash nuevo guardado.
      const updateArgs = prisma.kiosko.update.mock.calls[0][0].data;
      expect(updateArgs.deviceTokenHash).not.toBe(hashDelToken);
      expect(updateArgs.deviceTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(updateArgs.deviceTokenCreadoAt).toBeInstanceOf(Date);
      // Token devuelto en claro distinto al viejo.
      expect(typeof deviceTokenPlain).toBe('string');
      expect(deviceTokenPlain).not.toBe(tokenPlano);
      expect(kiosko).toBeDefined();
    });

    it('falla si el kiosko no existe', async () => {
      const { svc } = crearKioskoMock(null);
      await expect(svc.regenerarDeviceToken(99, 1)).rejects.toThrow(NotFoundException);
    });
  });
});