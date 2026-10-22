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

function pedido(pedidoId: number, leaseToken: string, folio: string | null = null, notas: string | null = null): PedidoCloud {
  return {
    pedidoId,
    tiendaId: 5,
    leaseToken,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    externalIdPEDIDOS: null,
    numeroPedido: `PD-2026-${pedidoId}`,
    folio,
    fechaPedido: '2026-08-22T12:00:00.000Z',
    clienteNombre: 'Cliente',
    clienteEmail: `cliente-${pedidoId}@test.local`,
    clienteTelefono: null,
    shippingDireccion: null,
    shippingColonia: null,
    shippingCodigoPostal: null,
    shippingPaqueteria: null,
    notas,
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
  // Orden de las sentencias dentro de la transacción: la reserva del folio debe ir ANTES de GRABAR_PEDIDOS y en la MISMA.
  const orden: string[] = [];
  const reservas: number[] = [];
  let nextId = 0;
  let consecutivo = 0;
  let txs = 0;
  const fb = {
    query: async (sql: string) => {
      if (sql.includes('FROM TIENDAS')) return [{ IDTIENDA: 50 }];
      return [];
    },
    transaction: async (work: any) => { const txn = ++txs; return work({
      callScalar: async (sql: string, params: any[]) => {
        // Firebird rechaza la llamada si los `?` no son tantos como los valores ("Input parameter mismatch"). La
        // transacción de mentira no lo vería: se comprueba aquí.
        assert.equal((sql.match(/\?/g) ?? []).length, params.length, `placeholders vs parámetros en: ${sql}`);
        if (sql.includes('CONSECUTIVOS')) {
          orden.push(`tx${txn}:CONSECUTIVOS`);
          reservas.push(params[0]);
          return { FOLIO: String(++consecutivo).padStart(10, '0') };
        }
        if (sql.includes('GRABAR_PEDIDOS')) {
          orden.push(`tx${txn}:GRABAR_PEDIDOS`);
          pedidoCalls.push(params);
          const id = ids[nextId++];
          // Con IDPEDIDO ≠ 0 el procedimiento real escribe (y devuelve) el FOLIO que se le manda.
          return { PEDIDO_ID: id, PEDIDO_FOLIO: params[2], CMENSAJEERROR: '' };
        }
        movpedCalls.push(params);
        return { MOVPED_ID: 1000 + movpedCalls.length, CMENSAJEERROR: '' };
      },
    }); },
  };
  return { fb, pedidoCalls, movpedCalls, orden, reservas };
}

describe('DownProcessor delivery', () => {
  it('recorta el folio CHAR(10) que Firebird devuelve relleno de espacios', async () => {
    const calls: string[] = [];
    const fb = {
      query: async (sql: string) => (sql.includes('FROM TIENDAS') ? [{ IDTIENDA: 50 }] : []),
      transaction: async (work: any) => work({
        callScalar: async (sql: string) => {
          calls.push(sql);
          if (sql.includes('CONSECUTIVOS')) return { FOLIO: '0000000123' };
          return sql.includes('GRABAR_PEDIDOS')
            ? { PEDIDO_ID: 9, PEDIDO_FOLIO: '0000000123 ', CMENSAJEERROR: null }
            : { MOVPED_ID: 1, CMENSAJEERROR: null };
        },
      }),
    };
    const acks: AckItem[] = [];
    const cloud = {
      heartbeat: async () => {},
      pollPedidos: async () => [pedido(101, 'lease-a')],
      pedidosAck: async (_s: number, b: AckItem[]) => { acks.push(...b); return { actualizados: 1, errores: 0 }; },
      getAgentId: () => 'agent-test',
    };
    const pending: any[] = [];
    const store = {
      dueAcks: () => pending.map((e, i) => ({ id: i + 1, tiendaId: e.tiendaId, payload: e.payload, attempts: 0 })),
      enqueueAck: (tiendaId: number, payload: any) => { pending.push({ tiendaId, payload }); return pending.length; },
      deleteAcks: () => { pending.splice(0); },
      scheduleAckRetry: () => {},
      getFolioReservado: () => null,
      setFolioReservado: () => {},
      confirmarFolio: () => {},
      getPedidoDelivery: () => undefined,
      setPedidoDelivery: () => {},
    };
    const cfg = { cloud: {}, firebird: {}, sync: { backoffMinMs: 1 }, service: { description: '' } } as any;
    const dp = new DownProcessor(cfg, fb as any, cloud as any, store as any, { info() {}, warn() {}, error() {}, fatal() {}, debug() {}, child() { return this; } } as any);
    await dp.runOnce();

    assert.equal(acks[0].externalFolio, '0000000123');
    // Son procedimientos ejecutables: con SELECT Firebird contesta "not selectable".
    assert.ok(
      calls.filter((c) => !c.includes('CONSECUTIVOS')).every((c) => c.startsWith('EXECUTE PROCEDURE ')),
      calls.join(' | '),
    );
  });

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
      getFolioReservado: () => null,
      setFolioReservado: () => {},
      confirmarFolio: () => {},
      getPedidoDelivery: () => null,
      setPedidoDelivery: (storeId: number, orderId: number, externalId: number, folio: string) => {
        deliveries.set(`${storeId}:${orderId}`, { externalId, folio });
      },
    };
    const processor = new DownProcessor(cfg, fb as any, cloud as any, store as any, logger());

    const result = await processor.runOnce();

    assert.deepEqual(result, { descargados: 2, errores: 0 });
    assert.deepEqual(acks.map((ack) => [ack.pedidoId, ack.externalIdPEDIDOS, ack.externalFolio]), [
      // Sin folio en la nube, el agente toma uno por pedido del consecutivo de la tienda (1, 2…).
      [101, 501, '0000000001'],
      [102, 502, '0000000002'],
    ]);
    assert.equal(pedidoCalls[0][0], 0);
    assert.equal(pedidoCalls[1][0], 0);
    assert.equal(movpedCalls[0][3], 901);
    assert.equal(movpedCalls[1][3], 902);
    assert.deepEqual(deliveries.get('50:101'), { externalId: 501, folio: '0000000001' });
    assert.deepEqual(deliveries.get('50:102'), { externalId: 502, folio: '0000000002' });
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
      getFolioReservado: () => null,
      setFolioReservado: () => {},
      confirmarFolio: () => {},
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
      getFolioReservado: () => null,
      setFolioReservado: () => {},
      confirmarFolio: () => {},
      getPedidoDelivery: (_s: number, pedidoId: number) =>
        pedidoId === 301 ? { externalIdPEDIDOS: 900, externalFolio: 'F-900' } : null,
      setPedidoDelivery: () => {},
    };
    const processor = new DownProcessor(cfg, fb as any, cloud as any, store as any, logger());

    await processor.runOnce();

    // GRABAR_PEDIDOS recibe 900 (el ID local previo), NO 0.
    assert.equal(pedidoCalls[0][0], 900);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Oct 2026 (parte B): el folio del ERP. Antes: `numeroPedido.slice(0, 10)` → todo pedido web quedaba con "PD-2026-00".
  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function storeSimple(
    previo: { externalIdPEDIDOS: number | null; externalFolio: string | null } | null = null,
    reservados: Map<string, string> = new Map(),
    confirmados: string[] = [],
  ) {
    const pendientes: Array<{ tiendaId: number; payload: any }> = [];
    return {
      getFolioReservado: (t: number, p: number) => reservados.get(`${t}:${p}`) ?? null,
      setFolioReservado: (t: number, p: number, f: string) => { reservados.set(`${t}:${p}`, f); },
      confirmarFolio: (t: number, p: number) => { confirmados.push(`${t}:${p}`); },
      dueAcks: () => pendientes.map((e, i) => ({ id: i + 1, tiendaId: e.tiendaId, payload: e.payload, attempts: 0 })),
      enqueueAck: (tiendaId: number, payload: any) => { pendientes.push({ tiendaId, payload }); return pendientes.length; },
      deleteAcks: () => { pendientes.splice(0); },
      scheduleAckRetry: () => {},
      getPedidoDelivery: () => previo,
      setPedidoDelivery: () => {},
    };
  }
  const nubeCon = (p: PedidoCloud, acks: AckItem[] = []) => ({
    heartbeat: async () => {},
    pollPedidos: async () => [p],
    pedidosAck: async (_s: number, b: AckItem[]) => { acks.push(...b); return { actualizados: 1, errores: 0 }; },
    getAgentId: () => 'agent-test',
  });

  it('manda a GRABAR_PEDIDOS el folio que la nube ya reservó y NO toma otro consecutivo', async () => {
    const { fb, pedidoCalls, reservas } = firebirdFake([801]);
    const acks: AckItem[] = [];
    const dp = new DownProcessor(cfg, fb as any, nubeCon(pedido(401, 'l', '0000152574'), acks) as any, storeSimple() as any, logger());

    await dp.runOnce();

    assert.equal(pedidoCalls[0][2], '0000152574');
    assert.deepEqual(reservas, [], 'no debe gastar un número si la nube ya tiene folio');
    assert.equal(acks[0].externalFolio, '0000152574');
  });

  it('sin folio en la nube toma el siguiente en SU PROPIA transacción corta, antes de la de GRABAR_PEDIDOS', async () => {
    const { fb, pedidoCalls, orden, reservas } = firebirdFake([802]);
    const acks: AckItem[] = [];
    const reservados = new Map<string, string>();
    const dp = new DownProcessor(cfg, fb as any, nubeCon(pedido(402, 'l', null), acks) as any, storeSimple(null, reservados) as any, logger());

    await dp.runOnce();

    // Transacciones distintas: el candado sobre la fila del consecutivo (la comparte VFP) dura milisegundos, no todo el
    // grabado del pedido y sus líneas.
    assert.deepEqual(orden.slice(0, 2), ['tx1:CONSECUTIVOS', 'tx2:GRABAR_PEDIDOS']);
    assert.deepEqual(reservas, [50], 'el consecutivo es el de la tienda del pedido');
    assert.equal(pedidoCalls[0][2], '0000000001');
    assert.equal(acks[0].externalFolio, '0000000001');
    assert.equal(reservados.get('50:402'), '0000000001', 'queda guardado: un reintento no gasta otro número');
  });

  it('al grabar el pedido el folio reservado queda CONFIRMADO: el agente no se lo reenvía a la nube cada ciclo', async () => {
    const { fb } = firebirdFake([809]);
    const confirmados: string[] = [];
    const dp = new DownProcessor(
      cfg,
      fb as any,
      nubeCon(pedido(409, 'l', null)) as any,
      storeSimple(null, new Map(), confirmados) as any,
      logger(),
    );
    await dp.runOnce();
    assert.deepEqual(confirmados, ['50:409']);
  });

  it('si el grabado falla y se reintenta, REUSA el folio ya tomado en vez de gastar otro', async () => {
    const { fb, reservas, pedidoCalls } = firebirdFake([803]);
    const reservados = new Map<string, string>([['50:403', '0000000555']]); // un intento anterior ya lo tomó
    const dp = new DownProcessor(cfg, fb as any, nubeCon(pedido(403, 'l', null)) as any, storeSimple(null, reservados) as any, logger());
    await dp.runOnce();
    assert.deepEqual(reservas, [], 'no tocó CONSECUTIVOS');
    assert.equal(pedidoCalls[0][2], '0000000555');
  });

  it('nunca manda el "PD-2026-xx" del número interno como folio', async () => {
    const { fb, pedidoCalls } = firebirdFake([803]);
    const dp = new DownProcessor(cfg, fb as any, nubeCon(pedido(403, 'l', null)) as any, storeSimple() as any, logger());
    await dp.runOnce();
    assert.match(pedidoCalls[0][2], /^\d{10}$/);
  });

  it('un folio basura en la nube se ignora y se toma uno real', async () => {
    const { fb, pedidoCalls, reservas } = firebirdFake([804]);
    const dp = new DownProcessor(cfg, fb as any, nubeCon(pedido(404, 'l', 'PD-2026-00')) as any, storeSimple() as any, logger());
    await dp.runOnce();
    assert.deepEqual(reservas, [50]);
    assert.match(pedidoCalls[0][2], /^\d{10}$/);
  });

  it('en un reintento manda el folio que YA quedó en el ERP aunque la nube tenga otro (lo que está en Firebird manda)', async () => {
    const { fb, pedidoCalls, reservas } = firebirdFake([805]);
    const dp = new DownProcessor(
      cfg,
      fb as any,
      nubeCon(pedido(405, 'l', '0000000999')) as any,
      storeSimple({ externalIdPEDIDOS: 805, externalFolio: '0000000777' }) as any,
      logger(),
    );
    await dp.runOnce();
    assert.equal(pedidoCalls[0][2], '0000000777');
    assert.deepEqual(reservas, []);
  });

  it('marca el origen WEB en NOTAS con el número de la nube, antes de las notas del cliente', async () => {
    const { fb, pedidoCalls } = firebirdFake([806, 807]);
    const dp1 = new DownProcessor(cfg, fb as any, nubeCon(pedido(406, 'l', '0000000001', 'Pasa por él mi hermano')) as any, storeSimple() as any, logger());
    await dp1.runOnce();
    assert.equal(pedidoCalls[0][12], 'WEB PD-2026-406 | Pasa por él mi hermano');

    const dp2 = new DownProcessor(cfg, fb as any, nubeCon(pedido(407, 'l', '0000000002', null)) as any, storeSimple() as any, logger());
    await dp2.runOnce();
    assert.equal(pedidoCalls[1][12], 'WEB PD-2026-407');
  });
});
