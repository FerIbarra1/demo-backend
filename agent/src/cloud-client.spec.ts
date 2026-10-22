import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CloudClient, MAX_BYTES_POR_POST, partirPorTamano } from './cloud-client';
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

  it('quita las llaves internas (_bandejaId): el servidor rechaza con 400 todo campo que no conoce', async () => {
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
        eventId: 'BANDEJA:12:PEDIDOS:7:5', bandejaId: 12, tipo: 'PAGO', operacion: 'U',
        entidad: 'PEDIDOS', localId: 7, localTiendaId: 5, datos: { FINALIZADA: true },
        _bandejaId: 12,
      } as any],
    });

    assert.deepEqual(Object.keys(requests[0].data.eventos[0]).filter((k) => k.startsWith('_')), []);
    assert.equal(requests[0].data.eventos[0].datos.FINALIZADA, true);
  });

  it('parte un lote grande en varios POST por tamaño y suma las respuestas', async () => {
    const client = new CloudClient(config, logger());
    const requests: any[] = [];
    (client as any).http.request = async (request: any) => {
      requests.push(request);
      return {
        data: { procesados: request.data.eventos.length, errores: 0, checkpointAvanzado: true, deadLetters: 0 },
        status: 200,
      };
    };
    // 200 filas de ~1 kb = ~200 kb: con el límite de 100 kb del servidor serían un 413.
    const eventos = Array.from({ length: 200 }, (_, i) => ({
      eventId: `BOOT:PRECIOSCO:${i}`, bandejaId: 0, tipo: 'CATALOGO' as const, operacion: 'I' as const,
      entidad: 'PRECIOSCO', localId: i, datos: { RELLENO: 'x'.repeat(1000) },
    }));

    const res = await client.upload({ tiendaId: 5, hastaBANDEJAId: 0, eventos });

    assert.ok(requests.length > 1);
    for (const r of requests) assert.ok(Buffer.byteLength(JSON.stringify(r.data)) < 100_000);
    assert.equal(requests.reduce((a, r) => a + r.data.eventos.length, 0), 200);
    assert.equal(res.procesados, 200);
    assert.equal(res.checkpointAvanzado, true);
  });

  it('si un trozo falla, el lote completo NO avanza el checkpoint', async () => {
    const client = new CloudClient(config, logger());
    let n = 0;
    (client as any).http.request = async (request: any) => {
      n++;
      const falla = n === 2;
      return {
        data: { procesados: falla ? 0 : request.data.eventos.length, errores: falla ? 1 : 0, checkpointAvanzado: !falla },
        status: 200,
      };
    };
    const eventos = Array.from({ length: 200 }, (_, i) => ({
      eventId: `E:${i}`, bandejaId: i + 1, tipo: 'CATALOGO' as const, operacion: 'U' as const,
      entidad: 'PRECIOS', localId: i, datos: { RELLENO: 'x'.repeat(1000) },
    }));
    const res = await client.upload({ tiendaId: 5, hastaBANDEJAId: 200, eventos });
    assert.equal(res.checkpointAvanzado, false);
    assert.equal(res.errores, 1);
  });

  it('partirPorTamano: nunca parte un evento y respeta el tope', () => {
    const grande = { eventId: 'G', bandejaId: 1, tipo: 'CATALOGO' as const, operacion: 'I' as const, entidad: 'X', localId: 1, datos: { a: 'x'.repeat(MAX_BYTES_POR_POST * 2) } };
    const chico = { ...grande, eventId: 'C', datos: {} };
    const trozos = partirPorTamano([chico, grande, chico], MAX_BYTES_POR_POST);
    assert.deepEqual(trozos.map((t) => t.map((e) => e.eventId)), [['C'], ['G'], ['C']]);
    assert.deepEqual(partirPorTamano([], 10), [[]]);
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
