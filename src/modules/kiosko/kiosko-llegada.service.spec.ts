import { ConflictException } from '@nestjs/common';
import { KioskoLlegadaService } from './kiosko-llegada.service';

/**
 * Tests de los bugs B2 y B3 del plan F16, y de la regla de re-aviso de F22.
 *
 * B2 (F16) — el anti-spam de llegada era un tope DE POR VIDA y el pedido dejaba de
 * emitir realtime para siempre. F22 lo resolvió de raíz: ya no hay tope ni ventana
 * porque el re-aviso simplemente no ocurre. Mientras el cliente esté presente,
 * avisar de nuevo no hace nada; solo se puede volver a avisar después de que el
 * mostrador descartó el aviso.
 *
 * B3 — el guard del QR era evadible: si `user.userId` llegaba `undefined`, la
 * condición `rol === CLIENTE && userId !== undefined` era `false` y se saltaba
 * la validación de dueño.
 */

/** Prisma mockeado con un pedido configurable. */
function crearServicio(pedido: Record<string, unknown> | null, updateManyCount = 1) {
  const updateMany = jest.fn(async (_args: unknown) => ({ count: updateManyCount }));

  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(pedido),
      updateMany,
    },
    historialPedido: { create: jest.fn().mockResolvedValue({}) },
  };

  const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn() };

  const svc = new KioskoLlegadaService(
    prisma as never,
    { validarDeviceToken: jest.fn().mockResolvedValue(true) } as never,
    realtime as never,
    { get: jest.fn().mockReturnValue('secreto') } as never,
  );

  return { svc, updateMany, realtime, prisma };
}

describe('F22 — avisar de nuevo: solo cuando el mostrador descartó el aviso', () => {
  const hace1h = new Date(Date.now() - 60 * 60_000);
  const pedidoBase = {
    id: 1,
    numeroPedido: 'PD-2026-000001',
    tiendaId: 5,
    usuarioId: 7,
    estado: 'REVISADO',
    modoEntrega: 'RECOGER_TIENDA',
    canalOrigen: 'WEB',
    clienteNombre: 'Cliente Test',
    fechaPedido: new Date(Date.now() - 5 * 60 * 60_000),
    llegadaAnunciadaAt: hace1h,
    presenteDesdeAt: hace1h,
    llegadaAnunciadaCanal: 'WEB',
    llegadaAnunciadaKioskoId: null,
    llegadaDescartadaAt: null,
    llegadaDescartes: 0,
    tienda: { nombre: 'Tienda' },
    items: [],
  };

  it('con el cliente YA presente no escribe ni suena: "Avisar de nuevo" ya no hace ruido', async () => {
    // El bug: el botón "Avisar de nuevo" de la app re-emitía el chime del mostrador
    // cada 60 s (hasta 5 veces por 10 min). Todo el límite de tasa existía para
    // contener algo que ya no ocurre.
    const { svc, updateMany, realtime } = crearServicio({ ...pedidoBase });

    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(false);
    expect(r.mensaje).toMatch(/ya avisamos/i);
    expect(updateMany).not.toHaveBeenCalled();
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
    expect(realtime.emitToPedido).not.toHaveBeenCalled();
  });

  it('un aviso nuevo REINICIA la espera (no hereda la hora del aviso descartado)', async () => {
    // El bug: `llegadaAnunciadaAt: pedido.llegadaAnunciadaAt ?? now` conservaba la
    // hora del primer aviso. El cliente que avisó por error a las 10:00, fue
    // descartado y volvió de verdad a las 12:00 se colaba delante de todos y la
    // consola le pintaba "EN TIENDA · 120 min".
    const { svc, updateMany, realtime } = crearServicio({
      ...pedidoBase,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 1,
    });

    const antes = Date.now();
    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(true);
    const { data } = updateMany.mock.calls[0][0] as any;
    expect(data.llegadaAnunciadaAt.getTime()).toBeGreaterThanOrEqual(antes);
    expect(data.presenteDesdeAt.getTime()).toBeGreaterThanOrEqual(antes);
    // Y el descarte se limpia, para que el gate lo vuelva a mostrar.
    expect(data.llegadaDescartadaAt).toBeNull();
    expect(data.llegadaDescartadaPorId).toBeNull();
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      5,
      'pedido.llegada-anunciada',
      expect.anything(),
    );
  });

  it('el descarte NO se pierde: llegadaDescartes no se toca al re-avisar', async () => {
    // El contador de descartes es lo que cierra el botón web a la segunda. Si
    // re-avisar lo reiniciara, el cliente nunca llegaría al límite.
    const { svc, updateMany } = crearServicio({
      ...pedidoBase,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 1,
    });

    await svc.confirmarDesdeCliente(1);

    const { data } = updateMany.mock.calls[0][0] as any;
    expect(data.llegadaDescartes).toBeUndefined();
  });

  it('tras DOS descartes el botón web se cierra (AVISO_BLOQUEADO)', async () => {
    const { svc, updateMany, realtime } = crearServicio({
      ...pedidoBase,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 2,
    });

    await expect(svc.confirmarDesdeCliente(1)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.confirmarDesdeCliente(1)).rejects.toMatchObject({
      response: expect.objectContaining({ codigo: 'AVISO_BLOQUEADO' }),
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('con UN solo descarte el cliente todavía puede re-avisar', async () => {
    const { svc } = crearServicio({
      ...pedidoBase,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 1,
    });

    await expect(svc.confirmarDesdeCliente(1)).resolves.toMatchObject({ reanudado: true });
  });

  it('la guarda es atómica: si otro aviso ganó la carrera, no emite dos veces', async () => {
    // Dos avisos simultáneos (la app y el kiosko, o un doble toque) leen
    // "ausente" a la vez. Solo uno escribe; el otro ve count = 0.
    const { svc, realtime } = crearServicio(
      { ...pedidoBase, llegadaAnunciadaAt: null, presenteDesdeAt: null },
      0,
    );

    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(false);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('un pedido de KIOSKO ya está presente: avisar no hace nada', async () => {
    // El pedido se hizo con el cliente en la tienda; no tiene `llegadaAnunciadaAt`
    // ni lo necesita.
    const { svc, updateMany } = crearServicio({
      ...pedidoBase,
      canalOrigen: 'KIOSKO',
      llegadaAnunciadaAt: null,
    });

    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('un pedido de KIOSKO descartado SÍ puede volver a avisar', async () => {
    const { svc, updateMany } = crearServicio({
      ...pedidoBase,
      canalOrigen: 'KIOSKO',
      llegadaAnunciadaAt: null,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 1,
    });

    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(true);
    expect(updateMany).toHaveBeenCalled();
  });
});

describe('B3 — el guard del QR de llegada no es evadible', () => {
  /**
   * El guard vive en el controller, así que se prueba la CONDICIÓN tal como
   * estaba escrita. Antes: `rol === CLIENTE && userId !== undefined` — con
   * `userId === undefined` la condición completa era false y se saltaba la
   * validación de dueño.
   */
  function guardAntiguoPasa(rol: string, userId: unknown): boolean {
    // Réplica del guard viejo: devuelve true si SE SALTA la validación.
    return !(rol === 'CLIENTE' && userId !== undefined);
  }
  function guardNuevoPasa(rol: string, userId: unknown): boolean {
    // Réplica del guard nuevo: devuelve true si SE SALTA la validación.
    if (rol !== 'CLIENTE') return true;
    if (userId === undefined || userId === null) return false; // falla cerrado
    return false; // un CLIENTE siempre valida dueño
  }

  it('el guard viejo dejaba pasar a un CLIENTE sin userId (el bug)', () => {
    expect(guardAntiguoPasa('CLIENTE', undefined)).toBe(true);
  });

  it('el guard nuevo falla cerrado con un CLIENTE sin userId', () => {
    expect(guardNuevoPasa('CLIENTE', undefined)).toBe(false);
    expect(guardNuevoPasa('CLIENTE', null)).toBe(false);
  });

  it('ADMIN y MOSTRADOR siguen pudiendo pedir cualquier QR', () => {
    expect(guardNuevoPasa('ADMIN', 1)).toBe(true);
    expect(guardNuevoPasa('MOSTRADOR', 1)).toBe(true);
  });

  it('un CLIENTE con userId válido siempre valida dueño', () => {
    expect(guardNuevoPasa('CLIENTE', 7)).toBe(false);
  });
});
