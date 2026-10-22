import { SyncAgentService } from './sync-agent.service';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'BANDEJA:10:PRECIOS:20:5',
    bandejaId: 10,
    tipo: 'CATALOGO' as const,
    operacion: 'U' as const,
    entidad: 'PRECIOS',
    localId: 20,
    localTiendaId: 5,
    datos: { IDPRODUCTO: 1, IDTIENDA: 5 },
    ...overrides,
  };
}

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    syncEventInbox: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    syncCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    syncEventLog: { create: jest.fn() },
    tienda: { findUnique: jest.fn().mockResolvedValue({ id: 1, externalId: 5 }) },
    pedido: { findUnique: jest.fn() },
    pedidoPendienteEnvio: { findUnique: jest.fn(), update: jest.fn() },
    externalRef: { upsert: jest.fn() },
    ...overrides,
  };
  prisma.$transaction = jest.fn((callback: (tx: any) => Promise<unknown>) => callback(prisma));

  const catalog = { procesar: jest.fn().mockResolvedValue({ ok: true }) };
  const cliente = { procesar: jest.fn() };
  const pedidoPago = { procesar: jest.fn() };
  const pedidoDescarga = { poll: jest.fn() };
  const notifications = { enviarListoParaPagar: jest.fn() };
  const service = new SyncAgentService(
    prisma as any,
    catalog as any,
    cliente as any,
    pedidoPago as any,
    pedidoDescarga as any,
    notifications as any,
    { poll: jest.fn(), ack: jest.fn(), avisarFolioAsignado: jest.fn() } as any,
  );
  return { service, prisma, catalog };
}

describe('SyncAgentService upload idempotency', () => {
  it('does not execute a processed event twice', async () => {
    const { service, prisma, catalog } = makeService();
    prisma.syncEventInbox.findUnique.mockResolvedValue({
      estado: 'PROCESADO',
      mensaje: null,
      nextAttemptAt: new Date(0),
      intentos: 1,
    });

    const result = await service.procesarUpload({
      tiendaId: 5,
      hastaBANDEJAId: 10,
      eventos: [makeEvent()],
    });

    expect(result).toEqual({
      procesados: 1,
      errores: 0,
      checkpointAvanzado: true,
      deadLetters: 0,
      fallidos: [],
    });
    expect(catalog.procesar).not.toHaveBeenCalled();
    expect(prisma.syncCheckpoint.upsert).toHaveBeenCalled();
  });

  it('moves a repeatedly failing event to dead letter after the fifth attempt', async () => {
    const { service, prisma, catalog } = makeService();
    const event = makeEvent({ eventId: 'BANDEJA:11:PRECIOSCO:21:5', entidad: 'PRECIOSCO' });
    prisma.syncEventInbox.findUnique.mockResolvedValue({
      estado: 'ERROR',
      mensaje: 'dependency missing',
      nextAttemptAt: new Date(0),
      intentos: 4,
    });
    prisma.syncEventInbox.updateMany.mockResolvedValue({ count: 1 });
    catalog.procesar.mockResolvedValue({ ok: false, mensaje: 'dependency missing' });

    const result = await service.procesarUpload({
      tiendaId: 5,
      hastaBANDEJAId: 11,
      eventos: [event],
    });

    // Un DEAD_LETTER es terminal: NO cuenta como error y NO bloquea el
    // checkpoint. Se reporta aparte para que el batch avance y el agente no
    // quede atascado esperando un evento que nunca se va a recuperar.
    expect(result).toEqual({
      procesados: 0,
      errores: 0,
      checkpointAvanzado: true,
      deadLetters: 1,
      fallidos: [],
    });
    expect(catalog.procesar).toHaveBeenCalledTimes(1);
    expect(prisma.syncEventInbox.update).toHaveBeenCalledWith({
      where: { eventId: event.eventId },
      data: expect.objectContaining({
        estado: 'DEAD_LETTER',
        intentos: 5,
        ultimoErrorCode: 'HANDLER_ERROR',
      }),
    });
  });
});

describe('SyncAgentService — qué eventos fallaron (oct 2026)', () => {
  it('un evento que ya murió (DEAD_LETTER) es terminal: no se reprocesa, no cuenta como error y NO se vuelve a pedir', async () => {
    const { service, prisma, catalog } = makeService();
    prisma.syncEventInbox.findUnique.mockResolvedValue({
      estado: 'DEAD_LETTER',
      mensaje: 'x',
      nextAttemptAt: new Date(0),
      intentos: 5,
    });
    const r = await service.procesarUpload({
      tiendaId: 5,
      hastaBANDEJAId: 10,
      eventos: [makeEvent()],
    });

    // Antes caía al `create`, chocaba con su propia fila (P2002) y daba `errores++` para siempre: el agente lo reenviaba
    // eternamente y su checkpoint nunca avanzaba.
    expect(r).toMatchObject({ errores: 0, deadLetters: 1, checkpointAvanzado: true, fallidos: [] });
    expect(catalog.procesar).not.toHaveBeenCalled();
    expect(prisma.syncEventInbox.create).not.toHaveBeenCalled();
  });

  it('dice CUÁLES fallaron y se van a reintentar (el agente los guarda en su outbox): el que falla y el que está en espera', async () => {
    const { service, prisma, catalog } = makeService();
    prisma.syncEventInbox.findUnique
      .mockResolvedValueOnce(null) // el 1.º: nuevo, y su handler falla
      .mockResolvedValueOnce({
        estado: 'ERROR',
        mensaje: 'x',
        nextAttemptAt: new Date(Date.now() + 60_000),
        intentos: 2,
      }) // el 2.º: en espera
      .mockResolvedValueOnce(null); // el 3.º: nuevo y bien
    catalog.procesar
      .mockResolvedValueOnce({ ok: false, mensaje: 'Unique constraint' })
      .mockResolvedValueOnce({ ok: true });
    const r = await service.procesarUpload({
      tiendaId: 5,
      hastaBANDEJAId: 10,
      eventos: [
        makeEvent({ eventId: 'A' }),
        makeEvent({ eventId: 'B' }),
        makeEvent({ eventId: 'C' }),
      ],
    });
    expect(r.fallidos).toEqual(['A', 'B']);
    expect(r).toMatchObject({ procesados: 1, errores: 2, checkpointAvanzado: false });
  });
});

describe('SyncAgentService ACK ownership', () => {
  it('rejects an ACK with a lease that does not belong to the agent', async () => {
    const { service, prisma } = makeService();
    prisma.tienda.findUnique.mockResolvedValue({ externalId: 55 });
    prisma.pedido.findUnique.mockResolvedValue({ tiendaId: 5 });
    prisma.pedidoPendienteEnvio.findUnique.mockResolvedValue({
      estado: 'PROCESSING',
      claimedBy: 'agent-a',
      leaseToken: 'token-a',
      externalIdPEDIDOS: null,
    });

    const result = await service.procesarPedidosAck({
      tiendaId: 5,
      acks: [
        {
          pedidoId: 100,
          agentId: 'agent-b',
          leaseToken: 'token-b',
          externalIdPEDIDOS: 900,
          externalFolio: '00000900',
          exito: true,
        },
      ],
    });

    expect(result).toEqual({ actualizados: 0, errores: 1 });
    expect(prisma.pedidoPendienteEnvio.update).not.toHaveBeenCalled();
    expect(prisma.externalRef.upsert).not.toHaveBeenCalled();
  });
});
