import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CloudClient } from './cloud-client';
import type { Logger } from './logger-types';

function logger(): Logger {
  return {
    debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; },
  };
}

const config = {
  baseUrl: 'https://cloud.test/api',
  agentKey: 'agent-key',
  sucursalIds: [5],
  timeoutMs: 1000,
};

describe('CloudClient contract', () => {
  it('sends upload with store header and event identity', async () => {
    const client = new CloudClient(config, logger());
    const requests: any[] = [];
    (client as any).http.request = async (request: any) => {
      requests.push(request);
      return { data: { procesados: 1, errores: 0, checkpointAvanzado: true }, status: 200 };
    };

    await client.upload({
      tiendaId: 5,
      hastaBANDEJAId: 12,
      eventos: [{
        eventId: 'BANDEJA:12:PRODUCTOS:1:GLOBAL',
        bandejaId: 12,
        tipo: 'CATALOGO',
        operacion: 'U',
        entidad: 'PRODUCTOS',
        localId: 1,
        datos: {},
      }],
    });

    assert.equal(requests[0].url, '/api/sync/agent/upload');
    assert.equal(requests[0].headers['X-Sucursal-Id'], '5');
    assert.equal(requests[0].data.eventos[0].eventId, 'BANDEJA:12:PRODUCTOS:1:GLOBAL');
    assert.equal(requests[0].data.eventos[0].bandejaId, 12);
  });

  it('sends poll with store and agent headers', async () => {
    const client = new CloudClient(config, logger());
    const requests: any[] = [];
    (client as any).http.request = async (request: any) => {
      requests.push(request);
      return { data: { tiendaId: 5, pedidos: [] }, status: 200 };
    };

    await client.pollPedidos(5, 20);

    assert.equal(requests[0].url, '/api/sync/agent/poll-pedidos');
    assert.equal(requests[0].headers['X-Sucursal-Id'], '5');
    assert.equal(requests[0].headers['X-Agent-Id'], client.getAgentId());
    assert.equal(requests[0].params.limit, 20);
  });

  it('sends ACK with lease token, agent and store identity', async () => {
    const client = new CloudClient(config, logger());
    const requests: any[] = [];
    (client as any).http.request = async (request: any) => {
      requests.push(request);
      return { data: { actualizados: 1, errores: 0 }, status: 200 };
    };

    await client.pedidosAck(5, [{
      pedidoId: 101,
      agentId: client.getAgentId(),
      leaseToken: 'lease-101',
      externalIdPEDIDOS: 501,
      externalFolio: 'F-501',
      exito: true,
    }]);

    assert.equal(requests[0].url, '/api/sync/agent/pedidos-ack');
    assert.equal(requests[0].headers['X-Sucursal-Id'], '5');
    assert.deepEqual(requests[0].data, {
      tiendaId: 5,
      acks: [{
        pedidoId: 101,
        agentId: client.getAgentId(),
        leaseToken: 'lease-101',
        externalIdPEDIDOS: 501,
        externalFolio: 'F-501',
        exito: true,
      }],
    });
  });
});
