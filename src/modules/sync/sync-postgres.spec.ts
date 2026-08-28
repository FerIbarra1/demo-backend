import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SyncAgentService } from './sync-agent.service';

jest.setTimeout(15_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-8);
const email = `sync-integration-${suffix}@test.local`;
let tiendaId: number;
let tiendaExternalId: number;
let usuarioId: number;
let pedidoId: number;

beforeAll(async () => {
  await prisma.$connect();
  const tienda = await prisma.tienda.create({
    data: {
      nombre: `Sync test ${suffix}`,
      direccion: 'Test',
      ciudad: 'Test',
      estado: 'Test',
      externalId: Number(String(Date.now()).slice(-8)),
    },
  });
  tiendaId = tienda.id;
  tiendaExternalId = tienda.externalId!;

  const usuario = await prisma.usuario.create({
    data: {
      email,
      password: 'integration-test-only',
      nombre: 'Sync test',
      rol: 'CLIENTE',
    },
  });
  usuarioId = usuario.id;

  const pedido = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-TEST-${suffix}`,
      usuarioId,
      tiendaId,
      clienteNombre: 'Sync test',
      clienteEmail: email,
      subtotal: 100,
      total: 100,
    },
  });
  pedidoId = pedido.id;
});

afterAll(async () => {
  await prisma.syncEventInbox.deleteMany({ where: { tiendaId } });
  await prisma.externalRef.deleteMany({ where: { systemEntity: 'PEDIDO', systemId: pedidoId } });
  await prisma.usuarioTienda.deleteMany({ where: { usuarioId, tiendaId } });
  await prisma.pedidoPendienteEnvio.deleteMany({ where: { pedidoId } });
  await prisma.pedido.deleteMany({ where: { id: pedidoId } });
  await prisma.usuario.deleteMany({ where: { id: usuarioId } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

function makeSyncService() {
  return new SyncAgentService(
    prisma as any,
    { procesar: jest.fn() } as any,
    { procesar: jest.fn() } as any,
    { procesar: jest.fn() } as any,
    { poll: jest.fn() } as any,
    { enviarListoParaPagar: jest.fn().mockResolvedValue(undefined) } as any,
  );
}

describe('PostgreSQL sync integration', () => {
  it('enforces one customer membership per store', async () => {
    await prisma.usuarioTienda.create({
      data: { usuarioId, tiendaId, localClienteId: 7001, listaPrecioCodigo: '3' },
    });

    await expect(
      prisma.usuarioTienda.create({
        data: { usuarioId, tiendaId, localClienteId: 7002, listaPrecioCodigo: '4' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const membership = await prisma.usuarioTienda.findUnique({
      where: { usuarioId_tiendaId: { usuarioId, tiendaId } },
    });
    expect(membership?.listaPrecioCodigo).toBe('3');
  });

  it('deduplicates the same sync event id', async () => {
    const event = {
      eventId: `integration:${suffix}`,
      tiendaId,
      bandejaId: BigInt(9001),
      entidad: 'PRODUCTOS',
      operacion: 'U',
      localId: 11,
      estado: 'PROCESADO',
      payload: { eventId: `integration:${suffix}` },
      processedAt: new Date(),
    };
    await prisma.syncEventInbox.create({ data: event });

    await expect(
      prisma.syncEventInbox.create({ data: event }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('processes a valid ACK atomically with its ExternalRef', async () => {
    const queue = await prisma.pedidoPendienteEnvio.create({
      data: {
        pedidoId,
        estado: 'PROCESSING',
        claimedBy: 'agent-a',
        leaseToken: 'lease-valid',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const service = makeSyncService();

    const result = await service.procesarPedidosAck({
      tiendaId: tiendaExternalId,
      acks: [{
        pedidoId,
        agentId: 'agent-a',
        leaseToken: 'lease-valid',
        externalIdPEDIDOS: 9101,
        externalFolio: 'F-9101',
        exito: true,
      }],
    });

    expect(result).toEqual({ actualizados: 1, errores: 0 });
    const [updated, externalRef] = await Promise.all([
      prisma.pedidoPendienteEnvio.findUnique({ where: { id: queue.id } }),
      prisma.externalRef.findFirst({
        where: { systemEntity: 'PEDIDO', systemId: pedidoId, localId: 9101 },
      }),
    ]);
    expect(updated?.estado).toBe('PROCESADO');
    expect(updated?.externalFolio).toBe('F-9101');
    expect(externalRef?.localEntity).toBe('PEDIDOS');
  });

  it('treats the same successful ACK as an idempotent replay', async () => {
    const service = makeSyncService();
    const ack = {
      pedidoId,
      agentId: 'agent-a',
      leaseToken: 'lease-valid',
      externalIdPEDIDOS: 9101,
      externalFolio: 'F-9101',
      exito: true,
    };

    await expect(service.procesarPedidosAck({ tiendaId: tiendaExternalId, acks: [ack] }))
      .resolves.toEqual({ actualizados: 1, errores: 0 });
    expect(
      await prisma.externalRef.count({ where: { systemEntity: 'PEDIDO', systemId: pedidoId, localId: 9101 } }),
    ).toBe(1);
  });

  it('rejects an invalid lease without changing the queue', async () => {
    const queue = await prisma.pedidoPendienteEnvio.findUnique({ where: { pedidoId } });
    const service = makeSyncService();

    const result = await service.procesarPedidosAck({
      tiendaId: tiendaExternalId,
      acks: [{
        pedidoId,
        agentId: 'agent-b',
        leaseToken: 'lease-wrong',
        externalIdPEDIDOS: 9200,
        externalFolio: 'F-9200',
        exito: true,
      }],
    });

    expect(result).toEqual({ actualizados: 0, errores: 1 });
    const unchanged = await prisma.pedidoPendienteEnvio.findUnique({ where: { pedidoId } });
    expect(unchanged?.id).toBe(queue?.id);
    expect(unchanged?.externalIdPEDIDOS).toBe(9101);
    expect(await prisma.externalRef.count({ where: { systemId: pedidoId, localId: 9200 } })).toBe(0);
  });

  it('allows only one atomic claim for a pending order delivery', async () => {
    await prisma.pedidoPendienteEnvio.deleteMany({ where: { pedidoId } });
    const queue = await prisma.pedidoPendienteEnvio.create({
      data: { pedidoId, estado: 'PENDIENTE' },
    });

    const first = await prisma.pedidoPendienteEnvio.updateMany({
      where: { id: queue.id, estado: 'PENDIENTE' },
      data: {
        estado: 'PROCESSING',
        claimedBy: 'agent-a',
        leaseToken: 'lease-a',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const second = await prisma.pedidoPendienteEnvio.updateMany({
      where: { id: queue.id, estado: 'PENDIENTE' },
      data: {
        estado: 'PROCESSING',
        claimedBy: 'agent-b',
        leaseToken: 'lease-b',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    const claimed = await prisma.pedidoPendienteEnvio.findUnique({ where: { id: queue.id } });
    expect(claimed?.claimedBy).toBe('agent-a');
    expect(claimed?.leaseToken).toBe('lease-a');
  });
});
