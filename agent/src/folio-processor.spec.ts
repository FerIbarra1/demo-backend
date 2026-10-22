import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FolioProcessor } from './folio-processor';
import { AuthError, TransientError } from './cloud-client';
import type { FolioAck, SolicitudFolio } from './cloud-client';
import { LocalStore } from './checkpoint-store';
import type { AgentConfig } from './config';

let dataDir: string;
let store: LocalStore;
let n = 0;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'playerytees-folios-'));
  process.env.AGENT_DATA_DIR = dataDir;
});
after(() => {
  delete process.env.AGENT_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  store?.close();
  // Un archivo por prueba: cada una parte sin folios guardados.
  process.env.AGENT_DATA_DIR = join(dataDir, `t${++n}`);
  store = new LocalStore({} as AgentConfig);
});

const log: any = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
const solicitud = (pedidoId: number): SolicitudFolio => ({
  pedidoId,
  numeroPedido: `PD-2026-${pedidoId}`,
  leaseToken: `lease-${pedidoId}`,
  leaseUntil: new Date(Date.now() + 60_000).toISOString(),
});

/** Firebird de mentira: CONSECUTIVOS por tienda, y puede fallar a pedido. */
function firebird(opts: { tiendas?: number[]; falla?: (tiendaId: number) => Error | null } = {}) {
  const contadores = new Map<number, number>();
  const transacciones: Array<{ tiendaId: number; waitTimeoutSec?: number }> = [];
  const fb = {
    query: async () => (opts.tiendas ?? [1]).map((IDTIENDA) => ({ IDTIENDA })),
    transaction: async (work: any, o: { waitTimeoutSec?: number } = {}) => {
      let tiendaDeLaTx = 0;
      const r = await work({
        callScalar: async (_sql: string, params: any[]) => {
          tiendaDeLaTx = params[0];
          const error = opts.falla?.(tiendaDeLaTx);
          if (error) throw error;
          const siguiente = (contadores.get(tiendaDeLaTx) ?? 152573) + 1;
          contadores.set(tiendaDeLaTx, siguiente);
          return { FOLIO: String(siguiente).padStart(10, '0') };
        },
      });
      transacciones.push({ tiendaId: tiendaDeLaTx, waitTimeoutSec: o.waitTimeoutSec });
      return r;
    },
  };
  return { fb, contadores, transacciones };
}

function nube(solicitudes: Record<number, SolicitudFolio[]>, opts: { ack?: (t: number, a: FolioAck[]) => { actualizados: number; errores: number } } = {}) {
  const acks: Array<{ tiendaId: number; acks: FolioAck[] }> = [];
  const cloud = {
    getAgentId: () => 'agente-test',
    pollFolios: async (tiendaId: number) => solicitudes[tiendaId] ?? [],
    foliosAck: async (tiendaId: number, a: FolioAck[]) => {
      acks.push({ tiendaId, acks: a });
      return opts.ack ? opts.ack(tiendaId, a) : { actualizados: a.filter((x) => x.exito).length, errores: a.filter((x) => !x.exito).length };
    },
  };
  return { cloud, acks };
}

describe('FolioProcessor', () => {
  it('reserva un consecutivo por solicitud y lo contesta a la nube', async () => {
    const { fb } = firebird();
    const { cloud, acks } = nube({ 1: [solicitud(10), solicitud(11)] });
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();

    assert.deepEqual(r, { reservados: 2, errores: 0 });
    assert.deepEqual(
      acks[0].acks.map((a) => [a.pedidoId, a.exito, a.folio]),
      [[10, true, '0000152574'], [11, true, '0000152575']],
    );
    assert.deepEqual(store.foliosSinConfirmar(), [], 'la nube confirmó: nada queda pendiente');
  });

  it('la transacción tiene un tope de espera: no se queda colgada si VFP no suelta CONSECUTIVOS', async () => {
    const { fb, transacciones } = firebird();
    const { cloud } = nube({ 1: [solicitud(10)] });
    await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.deepEqual(transacciones, [{ tiendaId: 1, waitTimeoutSec: 10 }]);
  });

  it('cada tienda toma de SU consecutivo', async () => {
    const { fb, contadores } = firebird({ tiendas: [1, 2] });
    const { cloud, acks } = nube({ 1: [solicitud(10)], 2: [solicitud(20)] });
    await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.equal(contadores.get(1), 152574);
    assert.equal(contadores.get(2), 152574);
    assert.deepEqual(acks.map((a) => a.tiendaId), [1, 2]);
  });

  it('si el ACK no llega, el SIGUIENTE ciclo reusa el mismo folio en vez de gastar otro', async () => {
    const { fb, contadores } = firebird();
    let sinRed = true;
    const { cloud, acks } = nube({ 1: [solicitud(10)] }, {
      ack: () => {
        if (sinRed) throw new TransientError('sin red');
        return { actualizados: 1, errores: 0 };
      },
    });
    const proc = new FolioProcessor(fb as any, cloud as any, store, log);

    await proc.runOnce(); // reserva 0000152574, el ACK falla
    assert.equal(contadores.get(1), 152574);
    assert.deepEqual(store.foliosSinConfirmar().map((f) => [f.pedidoId, f.folio]), [[10, '0000152574']]);

    sinRed = false;
    await proc.runOnce(); // reintenta la confirmación pendiente y, si la nube la vuelve a ofrecer, reusa el folio
    assert.equal(contadores.get(1), 152574, 'NO se gastó otro número');
    assert.deepEqual(store.foliosSinConfirmar(), []);
    assert.ok(acks.some((a) => a.acks.some((x) => x.folio === '0000152574')));
  });

  it('si la nube vuelve a ofrecer la solicitud de un pedido ya reservado, contesta con el MISMO folio', async () => {
    const { fb, contadores } = firebird();
    store.setFolioReservado(1, 10, '0000999999');
    const { cloud, acks } = nube({ 1: [solicitud(10)] });
    await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.equal(contadores.size, 0, 'no tocó CONSECUTIVOS');
    assert.equal(acks[0].acks[0].folio, '0000999999');
  });

  it('si Firebird falla, le dice a la nube por qué (ella reintenta a los 30 s) y NO guarda nada', async () => {
    const { fb } = firebird({ falla: () => new Error('lock time-out on wait transaction') });
    const { cloud, acks } = nube({ 1: [solicitud(10)] });
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();

    assert.deepEqual(r, { reservados: 0, errores: 1 });
    assert.equal(acks[0].acks[0].exito, false);
    assert.match(acks[0].acks[0].error!, /lock time-out/);
    assert.equal(store.getFolioReservado(1, 10), null);
  });

  it('si pierde el turno contra otra transacción (VFP), reintenta y no le avisa a la nube de ningún fallo', async () => {
    let llamadas = 0;
    const { fb } = firebird({
      falla: () => (++llamadas === 1 ? Object.assign(new Error('Deadlock, Update conflicts with concurrent update'), { gdscode: 335544451 }) : null),
    });
    const { cloud, acks } = nube({ 1: [solicitud(10)] });
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.deepEqual(r, { reservados: 1, errores: 0 });
    assert.deepEqual(acks[0].acks.map((a) => [a.pedidoId, a.exito, a.folio]), [[10, true, '0000152574']]);
  });

  it('un fallo en un pedido no impide reservar los demás', async () => {
    let llamadas = 0;
    const { fb } = firebird({ falla: () => (++llamadas === 1 ? new Error('boom') : null) });
    const { cloud, acks } = nube({ 1: [solicitud(10), solicitud(11)] });
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.deepEqual(r, { reservados: 1, errores: 1 });
    assert.deepEqual(acks[0].acks.map((a) => [a.pedidoId, a.exito]), [[10, false], [11, true]]);
  });

  it('si la nube RECHAZA un folio reservado, se reintenta de uno en uno y se abandona tras 10 rechazos', async () => {
    const { fb } = firebird();
    const { cloud } = nube({ 1: [] }, { ack: () => ({ actualizados: 0, errores: 1 }) });
    store.setFolioReservado(1, 10, '0000152574');
    const proc = new FolioProcessor(fb as any, cloud as any, store, log);
    for (let i = 0; i < 9; i++) await proc.runOnce();
    assert.equal(store.foliosSinConfirmar().length, 1, 'aún se insiste');
    await proc.runOnce();
    assert.equal(store.foliosSinConfirmar().length, 0, 'abandonado (queda el rastro en el SQLite y en el log)');
    assert.equal(store.getFolioReservado(1, 10), '0000152574');
  });

  it('un 401/403 aborta el ciclo (el servicio se reinicia), un fallo de red solo salta la tienda', async () => {
    const { fb } = firebird({ tiendas: [1, 2] });
    const sinAuth = { getAgentId: () => 'a', pollFolios: async () => { throw new AuthError('no', 401); }, foliosAck: async () => ({ actualizados: 0, errores: 0 }) };
    await assert.rejects(() => new FolioProcessor(fb as any, sinAuth as any, store, log).runOnce(), AuthError);

    const solo2: Record<number, SolicitudFolio[]> = { 2: [solicitud(20)] };
    const cloud = {
      getAgentId: () => 'a',
      pollFolios: async (t: number) => { if (t === 1) throw new TransientError('red'); return solo2[t] ?? []; },
      foliosAck: async (_t: number, a: FolioAck[]) => ({ actualizados: a.length, errores: 0 }),
    };
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.deepEqual(r, { reservados: 1, errores: 0 });
  });

  it('sin solicitudes no toca Firebird', async () => {
    const { fb, transacciones } = firebird();
    const { cloud, acks } = nube({});
    const r = await new FolioProcessor(fb as any, cloud as any, store, log).runOnce();
    assert.deepEqual(r, { reservados: 0, errores: 0 });
    assert.equal(transacciones.length, 0);
    assert.equal(acks.length, 0);
  });
});

describe('LocalStore — folios reservados', () => {
  it('sobreviven a reabrir el archivo y no se pisan entre sí', () => {
    store.setFolioReservado(1, 10, '0000000001');
    store.setFolioReservado(1, 10, '0000000002'); // un segundo intento NO cambia el número ya tomado
    store.setFolioReservado(2, 10, '0000000009'); // mismo pedido id en otra tienda: otra fila
    assert.equal(store.getFolioReservado(1, 10), '0000000001');
    assert.equal(store.getFolioReservado(2, 10), '0000000009');
    store.close();
    store = new LocalStore({} as AgentConfig);
    assert.equal(store.getFolioReservado(1, 10), '0000000001');
  });

  it('un folio ABANDONADO (la nube lo rechazó N veces) no se ofrece para grabar en el ERP, y un número nuevo lo reemplaza', () => {
    store.setFolioReservado(1, 10, '0000000001');
    store.rechazarFolio(1, 10, 2);
    store.rechazarFolio(1, 10, 2); // 2 rechazos con tope 2 → estado 2 (abandonado)

    assert.equal(store.getFolioReservado(1, 10), '0000000001', 'FolioProcessor lo sigue viendo: queda el rastro');
    assert.equal(store.getFolioReservado(1, 10, true), null, 'pero NO es uno que se pueda grabar en el ERP');
    assert.equal(store.foliosSinConfirmar().length, 0, 'ya no se reintenta solo');

    store.setFolioReservado(1, 10, '0000000007'); // DownProcessor tomó uno nuevo
    assert.equal(store.getFolioReservado(1, 10, true), '0000000007');
    assert.equal(store.foliosSinConfirmar().length, 1, 'el nuevo vuelve a estar por confirmar, con los rechazos en cero');
    assert.equal(store.foliosSinConfirmar()[0].intentos, 0);
  });

  it('un folio VIGENTE se ofrece con y sin `soloVigentes`, y un número nuevo no lo pisa', () => {
    store.setFolioReservado(1, 10, '0000000001');
    store.rechazarFolio(1, 10, 10); // un rechazo de 10: sigue vigente
    assert.equal(store.getFolioReservado(1, 10, true), '0000000001');
    store.setFolioReservado(1, 10, '0000000002');
    assert.equal(store.getFolioReservado(1, 10), '0000000001');
  });

  it('confirmar lo saca de los pendientes', () => {
    store.setFolioReservado(1, 10, '0000000001');
    assert.equal(store.foliosSinConfirmar().length, 1);
    store.confirmarFolio(1, 10);
    assert.equal(store.foliosSinConfirmar().length, 0);
  });
});
