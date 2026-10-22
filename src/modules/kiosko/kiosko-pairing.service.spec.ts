import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { createHash } from 'crypto';
import { KioskoPairingService } from './kiosko-pairing.service';
import type { ActorKiosko } from './kiosko.service';

const admin: ActorKiosko = { userId: 99, rol: RolUsuario.ADMIN };
const gerente = (tiendaId: number): ActorKiosko => ({
  userId: 9,
  rol: RolUsuario.GERENTE,
  tiendaId,
});

/**
 * Oct 2026: una tablet pertenece a UNA tienda y, una vez vinculada, no cambia. Al aprobar un emparejamiento, si la
 * tablet cree ser de una tienda y el admin eligió un kiosko de OTRA, hay que confirmarlo expresamente: casi seguro
 * se equivocó de fila en el selector.
 */
function crear(opts: { hint: number | null; tiendaDelKiosko: number; updateCount?: number }) {
  const prisma = {
    kiosko: {
      findUnique: jest.fn().mockResolvedValue({
        id: 10,
        nombre: 'Kiosko 1',
        estado: 'ACTIVO',
        ultimoHeartbeat: null,
        tiendaId: opts.tiendaDelKiosko,
        tienda: { nombre: `Tienda ${opts.tiendaDelKiosko}` },
      }),
    },
    kioskoPairing: {
      findUnique: jest.fn().mockResolvedValue({ tiendaIdHint: opts.hint }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    },
    tienda: { findUnique: jest.fn().mockResolvedValue({ nombre: 'Tienda 2' }) },
  };
  return { svc: new KioskoPairingService(prisma as never), prisma };
}

describe('KioskoPairingService.aprobar — la tienda de la tablet', () => {
  it('si la tablet cree ser de la misma tienda del kiosko, aprueba sin más', async () => {
    const { svc, prisma } = crear({ hint: 1, tiendaDelKiosko: 1 });
    const r = await svc.aprobar('p1', 10, admin);
    expect(r.ok).toBe(true);
    expect(prisma.kioskoPairing.updateMany).toHaveBeenCalled();
  });

  it('una tablet sin pista (nueva) se aprueba sin más: no hay nada que contradecir', async () => {
    const { svc } = crear({ hint: null, tiendaDelKiosko: 1 });
    expect((await svc.aprobar('p1', 10, admin)).ok).toBe(true);
  });

  it('si la tablet cree ser de OTRA tienda, 409 TIENDA_DISTINTA y NO se aprueba', async () => {
    const { svc, prisma } = crear({ hint: 2, tiendaDelKiosko: 1 });
    await expect(svc.aprobar('p1', 10, admin)).rejects.toMatchObject({
      response: { codigo: 'TIENDA_DISTINTA' },
    });
    expect(prisma.kioskoPairing.updateMany).not.toHaveBeenCalled();
  });

  it('el mensaje nombra las dos tiendas para que el admin vea el error', async () => {
    const { svc } = crear({ hint: 2, tiendaDelKiosko: 1 });
    const err = await svc.aprobar('p1', 10, admin).catch((e) => e as ConflictException);
    const mensaje = (err as ConflictException).getResponse() as { message: string };
    expect(mensaje.message).toContain('Tienda 2');
    expect(mensaje.message).toContain('Tienda 1');
  });

  it('con confirmarOtraTienda sí se aprueba (la tablet se movió de tienda) y queda dicho en el log', async () => {
    const { svc, prisma } = crear({ hint: 2, tiendaDelKiosko: 1 });
    const r = await svc.aprobar('p1', 10, admin, { confirmarOtraTienda: true });
    expect(r.ok).toBe(true);
    expect(prisma.kioskoPairing.updateMany).toHaveBeenCalled();
  });

  it('una solicitud que ya no está disponible sigue siendo 409 aunque la tienda coincida', async () => {
    const { svc } = crear({ hint: 1, tiendaDelKiosko: 1, updateCount: 0 });
    await expect(svc.aprobar('p1', 10, admin)).rejects.toThrow(ConflictException);
  });

  it('un kiosko que no existe es 404', async () => {
    const { svc, prisma } = crear({ hint: 1, tiendaDelKiosko: 1 });
    prisma.kiosko.findUnique.mockResolvedValue(null);
    await expect(svc.aprobar('p1', 999, admin)).rejects.toThrow(NotFoundException);
  });
});

/**
 * `reclamar`: la tablet canjea la autorización por su device token. Lo que autoriza es el SECRETO que ella guarda,
 * no el código (que cualquiera en la tienda puede leer de la pantalla).
 */
describe('KioskoPairingService.reclamar', () => {
  const SECRETO = 'secreto-de-la-tablet-de-32-bytes-base64url';
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  function crearReclamo(kiosko: Record<string, unknown>, pairing: Record<string, unknown> = {}) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      kioskoPairing: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          deviceSecretHash: sha(SECRETO),
          estado: 'APROBADO',
          intentosFallidos: 0,
          expiraAt: new Date(Date.now() + 60_000),
          kiosko: {
            id: 10,
            nombre: 'Kiosko 1',
            tiendaId: 3,
            tienda: { id: 3, nombre: 'Hermosillo' },
            estado: 'ACTIVO',
            desactivadoAt: null,
            primerConexionAt: new Date('2026-10-01'),
            ...kiosko,
          },
          ...pairing,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      kiosko: { update },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          kioskoPairing: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          kiosko: { update },
        }),
      ),
    };
    return { svc: new KioskoPairingService(prisma as never), prisma, update };
  }

  it('con el secreto correcto entrega el token y la tienda DEL KIOSKO (no la que diga la tablet)', async () => {
    const { svc, update } = crearReclamo({});
    const r = await svc.reclamar('p1', SECRETO);
    expect(r.kioskoId).toBe(10);
    expect(r.tiendaId).toBe(3);
    expect(r.tiendaNombre).toBe('Hermosillo');
    expect(r.deviceTokenPlain.length).toBeGreaterThanOrEqual(40);
    // Se guarda solo el hash del token.
    expect(update.mock.calls[0][0].data.deviceTokenHash).toBe(sha(r.deviceTokenPlain));
  });

  it('un secreto distinto es un 404 idéntico al de "no existe" y suma un intento fallido', async () => {
    const { svc, prisma } = crearReclamo({});
    await expect(svc.reclamar('p1', 'otro-secreto-que-no-es-el-de-la-tablet')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.kioskoPairing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { intentosFallidos: { increment: 1 } } }),
    );
  });

  it('el primer emparejamiento fija primerConexionAt (distingue "pendiente de instalar" de "desvinculado")', async () => {
    const { svc, update } = crearReclamo({ primerConexionAt: null });
    await svc.reclamar('p1', SECRETO);
    expect(update.mock.calls[0][0].data.primerConexionAt).toBeInstanceOf(Date);
  });

  it('uno que ya tenía primerConexionAt lo conserva (no se pisa)', async () => {
    const { svc, update } = crearReclamo({});
    await svc.reclamar('p1', SECRETO);
    expect(update.mock.calls[0][0].data).not.toHaveProperty('primerConexionAt');
  });

  it('un kiosko APAGADO no se vincula ni se reactiva solo: 403', async () => {
    const { svc, update } = crearReclamo({
      estado: 'INACTIVO',
      desactivadoAt: new Date('2026-10-10'),
    });
    await expect(svc.reclamar('p1', SECRETO)).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('una solicitud que no está APROBADA (el admin no ha autorizado) es 404 y no entrega nada', async () => {
    const { svc, update } = crearReclamo({}, { estado: 'PENDIENTE' });
    await expect(svc.reclamar('p1', SECRETO)).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('una solicitud vencida es 404', async () => {
    const { svc } = crearReclamo({}, { expiraAt: new Date(Date.now() - 1000) });
    await expect(svc.reclamar('p1', SECRETO)).rejects.toThrow(NotFoundException);
  });
});

describe('KioskoPairingService — el GERENTE solo vincula en su tienda', () => {
  it('un kiosko de OTRA tienda es 404 y no se aprueba nada', async () => {
    const { svc, prisma } = crear({ hint: null, tiendaDelKiosko: 5 });
    await expect(svc.aprobar('p1', 10, gerente(3))).rejects.toThrow(NotFoundException);
    expect(prisma.kioskoPairing.updateMany).not.toHaveBeenCalled();
  });

  it('una tablet NUEVA (sin pista) la vincula a un kiosko de SU tienda', async () => {
    const { svc } = crear({ hint: null, tiendaDelKiosko: 3 });
    expect((await svc.aprobar('p1', 10, gerente(3))).ok).toBe(true);
  });

  it('una tablet que dice ser de OTRA tienda no se la lleva un gerente, ni confirmando: 403', async () => {
    const { svc, prisma } = crear({ hint: 5, tiendaDelKiosko: 3 });
    await expect(svc.aprobar('p1', 10, gerente(3), { confirmarOtraTienda: true })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.kioskoPairing.updateMany).not.toHaveBeenCalled();
  });

  it('cancelar: el gerente solo cancela solicitudes sin pista o de su tienda', async () => {
    const { svc, prisma } = crear({ hint: null, tiendaDelKiosko: 3 });
    await svc.cancelar('p1', gerente(3));
    expect(prisma.kioskoPairing.updateMany.mock.calls[0][0].where.OR).toEqual([
      { tiendaIdHint: null },
      { tiendaIdHint: 3 },
    ]);
    await svc.cancelar('p1', admin);
    expect(prisma.kioskoPairing.updateMany.mock.calls[1][0].where).not.toHaveProperty('OR');
  });
});
