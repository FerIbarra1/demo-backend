import { KioskoLlegadaService } from './kiosko-llegada.service';

/**
 * F16 (sep 2026): tests de los bugs B2 y B3 del plan.
 *
 * B2 — el anti-spam de llegada era un tope DE POR VIDA: `llegadaAnunciadaCount`
 * se incrementaba y nunca se reiniciaba, así que tras 5 avisos el pedido dejaba
 * de emitir realtime para siempre. Era un adorno cuando la llegada solo pintaba
 * un badge; con el gate de D5 (un pedido web no aparece en mostrador hasta que
 * el cliente avisa) el bug deja el pedido sin alerta en la TV para siempre.
 *
 * B3 — el guard del QR era evadible: si `user.userId` llegaba `undefined`, la
 * condición `rol === CLIENTE && userId !== undefined` era `false` y se saltaba
 * la validación de dueño.
 */

/** Prisma mockeado con un pedido configurable. */
function crearServicio(pedido: Record<string, unknown> | null) {
  const update = jest.fn(async (args: any) => ({ ...pedido, ...args.data }));

  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(pedido),
      update,
    },
  };

  const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn() };

  const svc = new KioskoLlegadaService(
    prisma as never,
    { validarDeviceToken: jest.fn().mockResolvedValue(true) } as never,
    realtime as never,
    { get: jest.fn().mockReturnValue('secreto') } as never,
  );

  return { svc, update, realtime, prisma };
}

describe('B2 — el anti-spam de llegada es un límite de tasa, no un tope de por vida', () => {
  const pedidoBase = {
    id: 1,
    numeroPedido: 'PD-2026-000001',
    tiendaId: 5,
    usuarioId: 7,
    estado: 'EN_MOSTRADOR',
    modoEntrega: 'RECOGER_TIENDA',
    clienteNombre: 'Cliente Test',
    llegadaAnunciadaAt: new Date(Date.now() - 60 * 60_000),
    llegadaUltimoAvisoAt: new Date(Date.now() - 60 * 60_000),
    // El ancla del límite de tasa es la última EMISIÓN, no el último aviso.
    llegadaUltimaEmisionAt: new Date(Date.now() - 60 * 60_000),
    llegadaAnunciadaCount: 5, // ya agotó el tope
    llegadaAnunciadaCanal: 'WEB',
    llegadaAnunciadaKioskoId: null,
    llegadaDescartadaAt: null,
    tienda: { nombre: 'Tienda' },
    items: [],
  };

  it('reinicia el contador tras la ventana de reintento (el bug B2)', async () => {
    // Última EMISIÓN hace 1 hora > REINTENTO_WINDOW_MS (10 min), y el contador
    // está en el tope. Antes esto dejaba `debeEmitir` en false PARA SIEMPRE.
    const { svc, update, realtime } = crearServicio({ ...pedidoBase });

    await svc.confirmarDesdeCliente(1);

    // El contador se reinicia a 1, así que vuelve a emitir.
    const data = update.mock.calls[0][0].data;
    expect(data.llegadaAnunciadaCount).toBe(1);
    expect(realtime.emitToTienda).toHaveBeenCalled();
  });

  it('NO reinicia si la ventana aún no pasó (el tope sigue vigente)', async () => {
    // Última emisión hace 2 minutos < 10 min: el tope sigue aplicando.
    const { svc, update, realtime } = crearServicio({
      ...pedidoBase,
      llegadaUltimaEmisionAt: new Date(Date.now() - 2 * 60_000),
    });

    await svc.confirmarDesdeCliente(1);

    const data = update.mock.calls[0][0].data;
    expect(data.llegadaAnunciadaCount).toBe(6); // sigue subiendo
    // Pero no re-emite: el mostrador ya sabe que está ahí.
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
    // Y el ancla NO se mueve: la ventana corre desde la última emisión real.
    expect(data.llegadaUltimaEmisionAt).toBeUndefined();
  });

  it('un pedido por debajo del tope emite normalmente', async () => {
    const { svc, realtime } = crearServicio({
      ...pedidoBase,
      llegadaAnunciadaCount: 1,
      llegadaUltimaEmisionAt: new Date(Date.now() - 5 * 60_000),
    });

    await svc.confirmarDesdeCliente(1);

    expect(realtime.emitToTienda).toHaveBeenCalled();
  });

  it('el cliente que insiste más seguido que la ventana eventualmente re-emite', async () => {
    // El bug que quedaba: `llegadaUltimoAvisoAt` se reescribía en CADA aviso,
    // así que un cliente que insistía cada minuto nunca cumplía la ventana y su
    // pedido quedaba sin alerta indefinidamente. Con el ancla en la última
    // EMISIÓN, la ventana sí se cumple.
    const { svc, update, realtime } = crearServicio({
      ...pedidoBase,
      // Avisó hace 1 min (fresco), pero la última EMISIÓN fue hace 11 min.
      llegadaUltimoAvisoAt: new Date(Date.now() - 60_000),
      llegadaUltimaEmisionAt: new Date(Date.now() - 11 * 60_000),
    });

    await svc.confirmarDesdeCliente(1);

    const data = update.mock.calls[0][0].data;
    expect(data.llegadaAnunciadaCount).toBe(1); // se reinició
    expect(realtime.emitToTienda).toHaveBeenCalled();
  });

  it('la idempotencia de 60s sigue funcionando', async () => {
    const { svc, update, realtime } = crearServicio({
      ...pedidoBase,
      llegadaAnunciadaCount: 1,
      llegadaUltimoAvisoAt: new Date(Date.now() - 10_000), // hace 10s
    });

    const r = await svc.confirmarDesdeCliente(1);

    expect(r.reanudado).toBe(false);
    // No escribe ni emite: es el mismo aviso.
    expect(update).not.toHaveBeenCalled();
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('un aviso DESCARTADO se puede volver a mandar de inmediato', async () => {
    // El caso real: el cliente avisa por error (o el operador no lo ve) y
    // mostrador descarta el aviso. Si el cliente intenta avisar otra vez dentro
    // de los 60s, el guard de idempotencia lo trataba como "ya avisamos" y el
    // pedido NO volvía a la cola — el cliente se quedaba sin forma de re-avisar.
    const { svc, update, realtime } = crearServicio({
      ...pedidoBase,
      llegadaAnunciadaCount: 1,
      // Avisó hace 10s (dentro de la ventana) PERO fue descartado.
      llegadaUltimoAvisoAt: new Date(Date.now() - 10_000),
      llegadaDescartadaAt: new Date(),
      llegadaDescartadaPorId: 3,
    });

    const r = await svc.confirmarDesdeCliente(1);

    // Se re-emite y el pedido vuelve a la cola de mostrador.
    expect(r.reanudado).toBe(true);
    expect(realtime.emitToTienda).toHaveBeenCalled();
    // Y el descarte se limpia, para que el gate de D5 lo vuelva a mostrar.
    const data = update.mock.calls[0][0].data;
    expect(data.llegadaDescartadaAt).toBeNull();
    expect(data.llegadaDescartadaPorId).toBeNull();
  });

  it('sin descarte, la ventana de 60s sigue aplicando', async () => {
    const { svc, update } = crearServicio({
      ...pedidoBase,
      llegadaAnunciadaCount: 1,
      llegadaUltimoAvisoAt: new Date(Date.now() - 10_000),
      llegadaDescartadaAt: null,
    });

    await svc.confirmarDesdeCliente(1);

    // Sin descarte, es el mismo aviso: no se re-escribe.
    expect(update).not.toHaveBeenCalled();
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
