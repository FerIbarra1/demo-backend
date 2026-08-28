import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DownProcessor } from './down-processor';
import type { AckItem, PedidoCloud } from './cloud-client';
import type { AgentConfig } from './config';
import type { Logger } from './logger-types';

const cfg = {
  cloud: { baseUrl: '', agentKey: '', timeoutMs: 1000 },
  firebird: {},
  sync: { backoffMinMs: 1, backoffMaxMs: 100, pollIntervalMs: 1 },
  service: { description: 'test' },
} as unknown as AgentConfig;

function logger(): Logger {
  return {
    debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; },
  };
}

function pedido(pedidoId: number, leaseToken: string): PedidoCloud {
  return {
    pedidoId,
    tiendaId: 5,
    leaseToken,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    externalIdPEDIDOS: null,
    numeroPedido: `PD-2026-${pedidoId}`,
    fechaPedido: '2026-08-22T12:00:00.000Z',
    clienteNombre: 'Cliente',
    clienteEmail: `cliente-${pedidoId}@test.local`,
    clienteTelefono: null,
    shippingDireccion: null,
    shippingColonia: null,
    shippingCodigoPostal: null,
    shippingPaqueteria: null,
    notas: null,
    subtotal: 100,
    total: 100,
    estado: 'APPROVED',
    modoEntrega: 'RECOGER_TIENDA',
    items: [{
      itemId: pedidoId,
      productoCodigo: 'CAM-001',
      cantidad: 1,
      precioUnitario: 100,
      subtotal: 100,
      talla: 'M',
      corridaNombre: 'BASE',
      colorNombre: 'NEGRO',
      localPrecioCOId: 700 + pedidoId,
      localProductoId: 800 + pedidoId,
      localCorridaId: 900,
      localColorId: 901,
      skip: false,
    }],
  };
}

function firebirdFake(ids: number[]) {
  const pedidoCalls: any[][] = [];
  const movpedCalls: any[][] = [];
  let nextId = 0;
  const fb = {
    query: async (sql: string) => {
      if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
      return [];
    },
    transaction: async (work: any) => work({
      callScalar: async (sql: string, params: any[]) => {
        if (sql.includes('GRABAR_PEDIDOS')) {
          pedidoCalls.push(params);
          const id = ids[nextId++];
          return { PEDIDO_ID: id, PEDIDO_FOLIO: `F-${id}`, CMENSAJEERROR: '' };
        }
        movpedCalls.push(params);
        return { MOVPED_ID: 1000 + movpedCalls.length, CMENSAJEERROR: '' };
      },
    }),
  };
  return { fb, pedidoCalls, movpedCalls };
}

describe('DownProcessor delivery', () => {
  it('keeps Firebird IDs and folios associated with the correct order', async () => {
    const { fb, pedidoCalls, movpedCalls } = firebirdFake([501, 502]);
    const acks: AckItem[] = [];
    const cloud = {
      heartbeat: async () => {},
      pollPedidos: async () => [pedido(101, 'lease-a'), pedido(102, 'lease-b')],
      pedidosAck: async (_store: number, batch: AckItem[]) => { acks.push(...batch); return { actualizados: 2, errores: 0 }; },
      getAgentId: () => 'agent-test',
    };
    const deliveries = new Map<string, any>();
    const pendingAcks: Array<{ tiendaId: number; payload: any }> = [];
    const store = {
      dueAcks: () => pendingAcks.map((entry, index) => ({ id: index + 1, tiendaId: entry.tiendaId, payload: entry.payload, attempts: 0 })),
      enqueueAck: (tiendaId: number, payload: any) => { pendingAcks.push({ tiendaId, payload }); return pendingAcks.length; },
      deleteAcks: () => { pendingAcks.splice(0); },
      scheduleAckRetry: () => {},
      getPedidoDelivery: () => null,
      setPedidoDelivery: (storeId: number, orderId: number, externalId: number, folio: string) => {
        deliveries.set(`${storeId}:${orderId}`, { externalId, folio });
      },
    };
    const processor = new DownProcessor(cfg, fb as any, cloud as any, store as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { descargados: 2, errores: 0 });
    assert.deepEqual(acks.map((ack) => [ack.pedidoId, ack.externalIdPEDIDOS, ack.externalFolio]), [
      [101, 501, 'F-501'],
      [102, 502, 'F-502'],
    ]);
    assert.equal(pedidoCalls[0][0], 0);
    assert.equal(pedidoCalls[1][0], 0);
    assert.equal(movpedCalls[0][3], 901);
    assert.equal(movpedCalls[1][3], 902);
    assert.deepEqual(deliveries.get('50:101'), { externalId: 501, folio: 'F-501' });
    assert.deepEqual(deliveries.get('50:102'), { externalId: 502, folio: 'F-502' });
  });

  it('retries a lost ACK without executing Firebird again', async () => {
    const { fb, pedidoCalls } = firebirdFake([601]);
    let ackAttempts = 0;
    const pendingAcks: Array<{ tiendaId: number; payload: any }> = [];
    const cloud = {
      heartbeat: async () => {},
      pollPedidos: async () => ackAttempts === 0 ? [pedido(201, 'lease-c')] : [],
      pedidosAck: async (_store: number, batch: AckItem[]) => {
        ackAttempts++;
        if (ackAttempts === 1) throw new Error('cloud unavailable');
        assert.equal(batch[0].externalIdPEDIDOS, 601);
        return { actualizados: 1, errores: 0 };
      },
      getAgentId: () => 'agent-test',
    };
    const store = {
      dueAcks: () => pendingAcks.map((entry, index) => ({ id: index + 1, tiendaId: entry.tiendaId, payload: entry.payload, attempts: 0 })),
      enqueueAck: (tiendaId: number, payload: any) => { pendingAcks.push({ tiendaId, payload }); return pendingAcks.length; },
      deleteAcks: () => { pendingAcks.splice(0); },
      scheduleAckRetry: () => {},
      getPedidoDelivery: () => null,
      setPedidoDelivery: () => {},
    };
    const processor = new DownProcessor(cfg, fb as any, cloud as any, store as any, logger());

    await processor.runOnce();
    assert.equal(pedidoCalls.length, 1);
    assert.equal(pendingAcks.length, 1);

    await processor.runOnce();
    assert.equal(pedidoCalls.length, 1);
    assert.equal(pendingAcks.length, 0);
    assert.equal(ackAttempts, 2);
  });

  it('reuses the local Firebird ID on retry (no duplicate pedido)', async () => {
    const { fb, pedidoCalls } = firebirdFake([701]);
    const cloud = {
      heartbeat: async () => {},
      pollPedidos: async () => [pedido(301, 'lease-d')],
      pedidosAck: async () => ({ actualizados: 1, errores: 0 }),
      getAgentId: () => 'agent-test',
    };
    // El pedido 301 ya se insertó en Firebird en un intento previo.
    const store = {
      dueAcks: () => [],
      enqueueAck: () => 1,
      deleteAcks: () => {},
      scheduleAckRetry: () => {},
      getPedidoDelivery: (_s: number, pedidoId: number) =>
        pedidoId === 301 ? { externalIdPEDIDOS: 900, externalFolio: 'F-900' } : null,
      setPedidoDelivery: () => {},
    };
    const processor = new DownProcessor(cfg, fb as any, cloud as any, store as any, logger());

    await processor.runOnce();

    // GRABAR_PEDIDOS recibe 900 (el ID local previo), NO 0.
    assert.equal(pedidoCalls[0][0], 900);
  });
});
