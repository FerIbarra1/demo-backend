import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpProcessor } from './up-processor';
import type { AgentConfig } from './config';
import { TransientError } from './cloud-client';
import type { UploadEvent } from './cloud-client';
import type { Logger } from './logger-types';

const cfg = {
  cloud: { baseUrl: '', agentKey: '', timeoutMs: 1000 },
  firebird: {},
  sync: { batchSize: 20, backoffMinMs: 1, backoffMaxMs: 100, pollIntervalMs: 1 },
  service: { description: 'test' },
} as unknown as AgentConfig;

function logger(): Logger {
  return {
    debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; },
  };
}

function event(eventId: string, bandejaId: number, tiendaId?: number): UploadEvent {
  return {
    eventId,
    bandejaId,
    tipo: 'CLIENTE',
    operacion: 'U',
    entidad: 'CLIENTES',
    localId: 10,
    localTiendaId: tiendaId,
    datos: { IDCLIENTE: 10, IDTIENDA: tiendaId },
  };
}

describe('UpProcessor upload flow', () => {
  it('fans out a multi-store client event with unique event IDs', async () => {
    const uploads: any[] = [];
    const fb = {
      query: async (sql: string) => {
        if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
        if (sql.includes('FROM BANDEJA_SYNC')) {
          return [{ ID: 10, TABLA: 'CLIENTES', IDTABLA: 10, OPERACION: 'U' }];
        }
        if (sql.includes('FROM CLIENTES')) return [{ IDCLIENTE: 10, NOMBRE: 'Cliente' }];
        if (sql.includes('FROM CLITIEN')) return [{ IDTIENDA: 50 }, { IDTIENDA: 60 }];
        return [];
      },
    };
    const cloud = {
      upload: async (batch: any) => { uploads.push(batch); return { procesados: batch.eventos.length, errores: 0, checkpointAvanzado: true }; },
    };
    const checkpoints = new Map<number, number>([[50, 100]]);
    const store = {
      dueOutbox: () => [],
      getCheckpoint: (id: number) => ({ ultimoBANDEJAId: checkpoints.get(id) ?? 0, pedidoExternalId: null }),
      setCheckpoint: (id: number, value: number) => checkpoints.set(id, value),
      minCheckpointPorTienda: () => Math.min(...checkpoints.values(), Number.MAX_SAFE_INTEGER),
      enqueue: () => 1,
      deleteOutbox: () => {},
      scheduleOutboxRetry: () => {},
      getMeta: () => '1',
      setMeta: () => {},
    };
    const resolver = { resolverTodas: async () => [50, 60] };
    const processor = new UpProcessor(cfg, fb as any, cloud as any, store as any, resolver as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { procesados: 2 });
    // Un POST por tienda nube (50→5, 60→6).
    assert.equal(uploads.length, 2);
    assert.deepEqual(
      uploads.flatMap((u) => u.eventos.map((e: UploadEvent) => e.localTiendaId)).sort(),
      [50, 60],
    );
    assert.equal(new Set(uploads.flatMap((u) => u.eventos.map((e: UploadEvent) => e.eventId))).size, 2);
    // C1: el checkpoint avanza POR TIENDA (clave 50), no global (clave 0).
    assert.equal(checkpoints.get(50), 10);
    assert.equal(checkpoints.get(60), 10);
  });

  it('does not advance checkpoint when cloud reports a failed event', async () => {
    const uploads: any[] = [];
    const fb = {
      query: async (sql: string) => {
        if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
        return sql.includes('FROM BANDEJA_SYNC')
          ? [{ ID: 11, TABLA: 'PRECIOS', IDTABLA: 99, OPERACION: 'U' }]
          : [];
      },
    };
    const cloud = {
      upload: async (batch: any) => { uploads.push(batch); return { procesados: 0, errores: 1, checkpointAvanzado: false }; },
    };
    let checkpoint = 100;
    const store = {
      dueOutbox: () => [],
      getCheckpoint: () => ({ ultimoBANDEJAId: checkpoint, pedidoExternalId: null }),
      setCheckpoint: (_id: number, value: number) => { checkpoint = value; },
      minCheckpointPorTienda: () => checkpoint,
      enqueue: () => 1,
      deleteOutbox: () => {},
      scheduleOutboxRetry: () => {},
      getMeta: () => '1',
      setMeta: () => {},
    };
    const resolver = { resolverTodas: async () => [50] };
    const processor = new UpProcessor(cfg, fb as any, cloud as any, store as any, resolver as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { procesados: 0 });
    assert.equal(uploads[0].eventos[0].bandejaId, 11);
    assert.equal(checkpoint, 100);
  });

  it('ignores unsupported entities (CONFTIENDAS) without blocking the checkpoint', async () => {
    const uploads: any[] = [];
    const fb = {
      query: async (sql: string) => {
        if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
        return sql.includes('FROM BANDEJA_SYNC')
          ? [{ ID: 20, TABLA: 'CONFTIENDAS', IDTABLA: 1, OPERACION: 'U' }]
          : [];
      },
    };
    const cloud = {
      upload: async (batch: any) => { uploads.push(batch); return { procesados: 1, errores: 0, checkpointAvanzado: true }; },
    };
    let checkpoint = 100;
    const store = {
      dueOutbox: () => [],
      getCheckpoint: () => ({ ultimoBANDEJAId: checkpoint, pedidoExternalId: null }),
      setCheckpoint: (_id: number, value: number) => { checkpoint = value; },
      minCheckpointPorTienda: () => checkpoint,
      enqueue: () => 1,
      deleteOutbox: () => {},
      scheduleOutboxRetry: () => {},
      getMeta: () => '1',
      setMeta: () => {},
    };
    const resolver = { resolverTodas: async () => [] };
    const processor = new UpProcessor(cfg, fb as any, cloud as any, store as any, resolver as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { procesados: 1 });
    // El evento CONFTIENDAS se envía con datos vacíos; el checkpoint avanza.
    assert.equal(uploads[0].eventos[0].entidad, 'CONFTIENDAS');
    assert.deepEqual(uploads[0].eventos[0].datos, {});
    assert.equal(checkpoint, 20);
  });

  it('stores every event when the cloud is transiently unavailable', async () => {
    const queued: UploadEvent[] = [];
    const fb = {
      query: async (sql: string) => {
        if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
        return sql.includes('FROM BANDEJA_SYNC')
          ? [{ ID: 12, TABLA: 'PRODUCTOS', IDTABLA: 1, OPERACION: 'U' }]
          : [];
      },
    };
    const cloud = {
      upload: async () => { throw new TransientError('offline'); },
    };
    const store = {
      dueOutbox: () => [],
      getCheckpoint: () => ({ ultimoBANDEJAId: 100, pedidoExternalId: null }),
      setCheckpoint: () => {},
      minCheckpointPorTienda: () => 100,
      enqueue: (_id: number, payload: UploadEvent) => { queued.push(payload); return queued.length; },
      deleteOutbox: () => {},
      scheduleOutboxRetry: () => {},
      getMeta: () => '1',
      setMeta: () => {},
    };
    const resolver = { resolverTodas: async () => [] };
    const processor = new UpProcessor(cfg, fb as any, cloud as any, store as any, resolver as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { procesados: 0 });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].eventId, 'BANDEJA:12:PRODUCTOS:1:GLOBAL');
  });

  it('uploads full catalog on first boot (bootstrap)', async () => {
    const uploads: any[] = [];
    const fb = {
      query: async (sql: string) => {
        if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
        if (sql.includes('RDB$RELATION_FIELDS')) {
          // Devolver 1 columna para todas las tablas de bootstrap.
          if (sql.includes("PRODUCTOS")) return [{ COL: 'IDPRODUCTO' }, { COL: 'CODIGO' }, { COL: 'DESCRIP' }];
          return [{ COL: 'IDPRECIO' }, { COL: 'IDPRODUCTO' }, { COL: 'IDTIENDA' }, { COL: 'PRECIO1' }];
        }
        if (sql.includes('FROM PRODUCTOS')) return [{ IDPRODUCTO: 1, CODIGO: 'CAM-001', DESCRIP: 'Camiseta' }];
        if (sql.includes('FROM CORRIDAS')) return [];
        if (sql.includes('FROM PRECIOS')) return [{ IDPRECIO: 10, IDPRODUCTO: 1, IDTIENDA: 50, PRECIO1: 199.90 }];
        return [];
      },
    };
    const cloud = {
      upload: async (batch: any) => {
        uploads.push(batch);
        return { procesados: batch.eventos.length, errores: 0, checkpointAvanzado: true };
      },
    };
    let bootstrapDone = false;
    const store = {
      dueOutbox: () => [],
      // Bootstrap se dispara por meta.bootstrap_catalogo (no por checkpoint).
      getCheckpoint: () => ({ ultimoBANDEJAId: 0, pedidoExternalId: null }),
      setCheckpoint: () => {},
      minCheckpointPorTienda: () => 0,
      enqueue: () => 1,
      deleteOutbox: () => {},
      scheduleOutboxRetry: () => {},
      getMeta: (key: string) => (key === 'bootstrap_catalogo' && bootstrapDone ? '1' : null),
      setMeta: (_key: string, value: string) => { if (value === '1') bootstrapDone = true; },
    };
    const resolver = { resolverTodas: async () => [] };
    const processor = new UpProcessor(cfg, fb as any, cloud as any, store as any, resolver as any, logger());

    await processor.runOnce();

    // Al menos un batch de PRODUCTOS y uno de PRECIOS por tienda.
    const entidades = uploads.flatMap((u) => u.eventos.map((e: UploadEvent) => e.entidad));
    assert.ok(entidades.includes('PRODUCTOS'), 'subió PRODUCTOS');
    assert.ok(entidades.includes('PRECIOS'), 'subió PRECIOS');
    assert.ok(bootstrapDone, 'marcó bootstrap_catalogo=1');
  });
});
