import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConciliacionProcessor } from './conciliacion';
import { AuthError } from './cloud-client';
import type { AgentConfig } from './config';

const log: any = { info() {}, warn() {}, error() {}, fatal() {}, debug() {}, child() { return this; } };
const cfg = (conciliacionIntervalMs?: number) => ({ sync: { conciliacionIntervalMs } }) as unknown as AgentConfig;

/** Firebird de mentira: `erp` es el contenido de PEDIDOS; TIENDAS devuelve las que se le pasen. */
function firebirdFake(erp: Record<number, any>, tiendas = [2]) {
  const consultas: number[][] = [];
  return {
    consultas,
    fb: {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes('FROM TIENDAS')) return tiendas.map((IDTIENDA) => ({ IDTIENDA }));
        assert.match(sql, /FROM PEDIDOS WHERE IDPEDIDO IN \(/);
        assert.equal((sql.match(/\?/g) ?? []).length, params.length);
        consultas.push(params);
        return params.filter((id) => erp[id]).map((id) => ({ IDPEDIDO: id, ...erp[id] }));
      },
    } as any,
  };
}

describe('ConciliacionProcessor.leerErp', () => {
  it('lee SWCANCEL/FINALIZADA/TTOTAL y marca como inexistente lo que Firebird ya no devuelve', async () => {
    const { fb } = firebirdFake({
      10: { SWCANCEL: false, FINALIZADA: true, TTOTAL: '250.50', IDFACTURA: 77 },
      11: { SWCANCEL: true, FINALIZADA: false, TTOTAL: 0, IDFACTURA: null },
    });
    const p = new ConciliacionProcessor(cfg(), fb, {} as any, log);
    const r = await p.leerErp([10, 11, 12]);
    assert.deepEqual(r[0], { externalIdPEDIDOS: 10, existe: true, swcancel: false, finalizada: true, total: 250.5, idfactura: 77 });
    assert.deepEqual(r[1], { externalIdPEDIDOS: 11, existe: true, swcancel: true, finalizada: false, total: 0, idfactura: null });
    assert.deepEqual(r[2], { externalIdPEDIDOS: 12, existe: false, swcancel: false, finalizada: false, total: null, idfactura: null });
  });

  it('parte la consulta IN (...) en trozos de 100 y conserva el orden', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 1000 + i);
    const { fb, consultas } = firebirdFake({});
    const r = await new ConciliacionProcessor(cfg(), fb, {} as any, log).leerErp(ids);
    assert.deepEqual(consultas.map((c) => c.length), [100, 100, 50]);
    assert.deepEqual(r.map((x) => x.externalIdPEDIDOS), ids);
  });

  it('acepta booleanos heredados (1 / "S") por si la columna no fuera BOOLEAN', async () => {
    const { fb } = firebirdFake({ 5: { SWCANCEL: 1, FINALIZADA: 'S', TTOTAL: 1, IDFACTURA: null } });
    const [x] = await new ConciliacionProcessor(cfg(), fb, {} as any, log).leerErp([5]);
    assert.equal(x.swcancel, true);
    assert.equal(x.finalizada, true);
  });
});

describe('ConciliacionProcessor.runOnce', () => {
  it('recorre las páginas de la nube, manda el estado real de cada una y suma el resultado', async () => {
    const { fb } = firebirdFake({ 1: { SWCANCEL: false, FINALIZADA: true, TTOTAL: 10, IDFACTURA: null }, 2: { SWCANCEL: false, FINALIZADA: false, TTOTAL: 10, IDFACTURA: null } });
    const pidio: Array<[number, number]> = [];
    const mandado: any[] = [];
    const paginas: Record<number, any> = {
      0: { tiendaId: 2, pedidos: [{ pedidoId: 100, externalIdPEDIDOS: 1 }], siguiente: 100 },
      100: { tiendaId: 2, pedidos: [{ pedidoId: 101, externalIdPEDIDOS: 2 }], siguiente: null },
    };
    const cloud = {
      conciliacionPendientes: async (t: number, _l: number, d: number) => { pidio.push([t, d]); return paginas[d]; },
      conciliar: async (b: any) => { mandado.push(b); return { revisados: b.pedidos.length, desconocidos: 0, curados: b.pedidos[0].finalizada ? 1 : 0, hallazgosAbiertos: 0, tareasCerradas: 0 }; },
    } as any;
    const r = await new ConciliacionProcessor(cfg(), fb, cloud, log).runOnce();

    assert.deepEqual(pidio, [[2, 0], [2, 100]]);
    assert.equal(mandado.length, 2);
    assert.equal(mandado[0].tiendaId, 2);
    assert.equal(mandado[0].pedidos[0].finalizada, true);
    assert.equal(r.revisados, 2);
    assert.equal(r.curados, 1);
  });

  it('sin pedidos que verificar igual avisa a la nube (queda anotado "se comparó, 0 revisados")', async () => {
    const { fb } = firebirdFake({});
    const mandado: any[] = [];
    const cloud = {
      conciliacionPendientes: async () => ({ tiendaId: 2, pedidos: [], siguiente: null }),
      conciliar: async (b: any) => { mandado.push(b); return { revisados: 0, desconocidos: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 }; },
    } as any;
    await new ConciliacionProcessor(cfg(), fb, cloud, log).runOnce();
    assert.deepEqual(mandado, [{ tiendaId: 2, pedidos: [] }]);
  });

  it('una tienda que la nube no conoce (404) no detiene a las demás; otro error de una tienda tampoco', async () => {
    const { fb } = firebirdFake({}, [1, 2, 3]);
    const vistas: number[] = [];
    const cloud = {
      conciliacionPendientes: async (t: number) => {
        vistas.push(t);
        if (t === 1) throw Object.assign(new Error('x'), { response: { status: 404 } });
        if (t === 2) throw new Error('se cayó la red');
        return { tiendaId: t, pedidos: [], siguiente: null };
      },
      conciliar: async () => ({ revisados: 0, desconocidos: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 }),
    } as any;
    await new ConciliacionProcessor(cfg(), fb, cloud, log).runOnce();
    assert.deepEqual(vistas, [1, 2, 3]);
  });

  it('un cursor que no avanza no deja al agente girando para siempre', async () => {
    const { fb } = firebirdFake({});
    let llamadas = 0;
    const cloud = {
      conciliacionPendientes: async () => { llamadas++; return { tiendaId: 2, pedidos: [], siguiente: 0 }; },
      conciliar: async () => ({ revisados: 0, desconocidos: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 }),
    } as any;
    await new ConciliacionProcessor(cfg(), fb, cloud, log).runOnce();
    assert.equal(llamadas, 1);
  });
});

describe('ConciliacionProcessor.runIfDue', () => {
  const nube = () => {
    let corridas = 0;
    return {
      get corridas() { return corridas; },
      cloud: {
        conciliacionPendientes: async () => { corridas++; return { tiendaId: 2, pedidos: [], siguiente: null }; },
        conciliar: async () => ({ revisados: 0, desconocidos: 0, curados: 0, hallazgosAbiertos: 0, tareasCerradas: 0 }),
      } as any,
    };
  };

  it('espera 30 s al arrancar y después corre una vez por intervalo', async () => {
    const { fb } = firebirdFake({});
    const n = nube();
    const t0 = 1_000_000;
    const p = new ConciliacionProcessor(cfg(60_000), fb, n.cloud, log, t0);
    assert.equal((await p.runIfDue(t0 + 10_000)).ejecutada, false);
    assert.equal((await p.runIfDue(t0 + 30_000)).ejecutada, true);
    assert.equal((await p.runIfDue(t0 + 40_000)).ejecutada, false);
    assert.equal((await p.runIfDue(t0 + 91_000)).ejecutada, true);
    assert.equal(n.corridas, 2);
  });

  it('con el intervalo en 0 queda apagada', async () => {
    const { fb } = firebirdFake({});
    const n = nube();
    const p = new ConciliacionProcessor(cfg(0), fb, n.cloud, log, 0);
    assert.equal((await p.runIfDue(10 * 60_000)).ejecutada, false);
    assert.equal(n.corridas, 0);
  });

  it('una pasada que falla NO tumba al ciclo; una llave de agente rechazada sí se propaga', async () => {
    const { fb } = firebirdFake({});
    // Firebird caído: ni siquiera se pueden listar las tiendas → la pasada no se ejecuta, pero NO lanza.
    const caido: any = { query: async () => { throw new Error('Firebird no responde'); } };
    const p = new ConciliacionProcessor(cfg(60_000), caido, {} as any, log, 0);
    assert.equal((await p.runIfDue(40_000)).ejecutada, false);
    // La nube se cae a media pasada: tampoco lanza (es lo de cada tienda).
    const rota: any = { conciliacionPendientes: async () => { throw new Error('boom'); }, conciliar: async () => ({}) };
    await new ConciliacionProcessor(cfg(60_000), fb, rota, log, 0).runIfDue(40_000);

    const sinAcceso: any = { conciliacionPendientes: async () => { throw new AuthError('no', 401); }, conciliar: async () => ({}) };
    const q = new ConciliacionProcessor(cfg(60_000), fb, sinAcceso, log, 0);
    await assert.rejects(() => q.runIfDue(40_000), AuthError);
  });
});
