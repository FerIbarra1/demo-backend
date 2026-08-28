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
  let prisma: any;
  prisma = {
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

    expect(result).toEqual({ procesados: 1, errores: 0, checkpointAvanzado: true });
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

    expect(result).toEqual({ procesados: 0, errores: 1, checkpointAvanzado: false });
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
      acks: [{
        pedidoId: 100,
        agentId: 'agent-b',
        leaseToken: 'token-b',
        externalIdPEDIDOS: 900,
        externalFolio: '00000900',
        exito: true,
      }],
    });

    expect(result).toEqual({ actualizados: 0, errores: 1 });
    expect(prisma.pedidoPendienteEnvio.update).not.toHaveBeenCalled();
    expect(prisma.externalRef.upsert).not.toHaveBeenCalled();
  });
});
