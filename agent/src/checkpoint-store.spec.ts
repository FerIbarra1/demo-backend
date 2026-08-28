import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LocalStore } from './checkpoint-store';
import type { AgentConfig } from './config';

const config = {} as AgentConfig;
let dataDir: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'playerytees-agent-'));
  process.env.AGENT_DATA_DIR = dataDir;
});

after(() => {
  delete process.env.AGENT_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('LocalStore durability', () => {
  it('keeps delivery results isolated per order and survives reopen', () => {
    const first = new LocalStore(config);
    first.setPedidoDelivery(5, 101, 9001, 'F-001');
    first.setPedidoDelivery(5, 102, 9002, 'F-002');
    assert.deepEqual(first.getPedidoDelivery(5, 101), {
      externalIdPEDIDOS: 9001,
      externalFolio: 'F-001',
    });
    assert.deepEqual(first.getPedidoDelivery(5, 102), {
      externalIdPEDIDOS: 9002,
      externalFolio: 'F-002',
    });
    first.close();

    const reopened = new LocalStore(config);
    assert.deepEqual(reopened.getPedidoDelivery(5, 101), {
      externalIdPEDIDOS: 9001,
      externalFolio: 'F-001',
    });
    assert.deepEqual(reopened.getPedidoDelivery(5, 102), {
      externalIdPEDIDOS: 9002,
      externalFolio: 'F-002',
    });
    reopened.close();
  });

  it('does not move a checkpoint backwards', () => {
    const store = new LocalStore(config);
    store.setCheckpoint(5, 100);
    store.setCheckpoint(5, 90);
    assert.equal(store.getCheckpoint(5)?.ultimoBANDEJAId, 100);
    store.close();
  });

  it('retains an ACK until it is explicitly deleted and records retries', () => {
    const store = new LocalStore(config);
    const id = store.enqueueAck(5, { acks: [{ pedidoId: 101, leaseToken: 't' }] });
    assert.equal(store.dueAcks(10).length, 1);
    store.scheduleAckRetry([id], 60, 'cloud unavailable');
    assert.equal(store.dueAcks(10).length, 0);
    store.deleteAcks([id]);
    assert.equal(store.dueAcks(10).length, 0);
    store.close();
  });

  it('retains upload payloads until acknowledged', () => {
    const store = new LocalStore(config);
    const id = store.enqueue(5, { eventId: 'BANDEJA:1' });
    assert.deepEqual(store.dueOutbox(10)[0]?.payload, { eventId: 'BANDEJA:1' });
    store.scheduleOutboxRetry([id], 60, 'cloud unavailable');
    assert.equal(store.dueOutbox(10).length, 0);
    store.deleteOutbox([id]);
    assert.equal(store.dueOutbox(10).length, 0);
    store.close();
  });
});
