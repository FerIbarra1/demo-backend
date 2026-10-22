import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  esConflictoDeConcurrencia,
  esFolio,
  notasParaErp,
  REINTENTOS_RESERVA,
  reservarFolio,
  reservarFolioConReintentos,
  SQL_RESERVAR_FOLIO,
} from './folio';

describe('folio del Sistema Comercial', () => {
  it('es exactamente la sentencia que usa GRABAR_PEDIDOS con IDPEDIDO = 0 (misma fila, mismo orden de bloqueo que VFP)', () => {
    assert.match(SQL_RESERVAR_FOLIO, /^UPDATE CONSECUTIVOS SET CONSECUTIVO = CONSECUTIVO \+ 1 WHERE TIPO = 'PEDIDOS' AND IDTIENDA = \? RETURNING LPAD\(CONSECUTIVO, 10, '0'\)/);
    // Un solo `?`: Firebird rechaza la llamada si los parámetros no coinciden ("Input parameter mismatch").
    assert.equal((SQL_RESERVAR_FOLIO.match(/\?/g) ?? []).length, 1);
  });

  it('reservarFolio devuelve el folio de 10 dígitos de ESA tienda', async () => {
    const vistos: any[][] = [];
    const tx = {
      callScalar: async (_sql: string, params: any[] = []) => {
        vistos.push(params);
        return { FOLIO: '0000152574' } as any;
      },
    };
    assert.equal(await reservarFolio(tx as any, 1), '0000152574');
    assert.deepEqual(vistos, [[1]]);
  });

  it('recorta los espacios con que Firebird rellena un CHAR', async () => {
    const tx = { callScalar: async () => ({ FOLIO: '0000152574 ' }) as any };
    assert.equal(await reservarFolio(tx as any, 1), '0000152574');
  });

  it('una tienda sin fila en CONSECUTIVOS NO inventa una numeración paralela: falla', async () => {
    const tx = { callScalar: async () => null };
    await assert.rejects(() => reservarFolio(tx as any, 99), /tienda 99 no tiene consecutivo de PEDIDOS/);
  });

  it('un valor que no es un folio de 10 dígitos falla en vez de mandarse al ERP', async () => {
    for (const raro of ['152574', 'PD-2026-00', '00001525740']) {
      const tx = { callScalar: async () => ({ FOLIO: raro }) as any };
      await assert.rejects(() => reservarFolio(tx as any, 1), /folio inesperado/);
    }
  });

  it('esFolio', () => {
    assert.equal(esFolio('0000152573'), true);
    for (const v of ['', '152573', 'PD-2026-00', null, undefined, 1525730000]) assert.equal(esFolio(v), false);
  });
});

describe('NOTAS del pedido en el Sistema Comercial (origen WEB)', () => {
  it('antepone la marca WEB y el número interno a las notas del cliente', () => {
    assert.equal(notasParaErp('PD-2026-000123', 'Pasa por él mi hermano'), 'WEB PD-2026-000123 | Pasa por él mi hermano');
  });

  it('sin notas, solo la marca', () => {
    assert.equal(notasParaErp('PD-2026-000123', null), 'WEB PD-2026-000123');
    assert.equal(notasParaErp('PD-2026-000123', '   '), 'WEB PD-2026-000123');
  });

  it('respeta el tope de 2000 caracteres de NOTAS sin perder la marca', () => {
    const r = notasParaErp('PD-2026-000123', 'x'.repeat(5000));
    assert.equal(r.length, 2000);
    assert.ok(r.startsWith('WEB PD-2026-000123 | '));
  });
});

describe('choques de concurrencia sobre CONSECUTIVOS', () => {
  // Medido contra el Firebird real: 4 transacciones simultáneas sobre la misma fila → ~30% contestan "Deadlock, Update
  // conflicts with concurrent update" aunque sean READ COMMITTED + WAIT. Es perder el turno, no un fallo.
  const conflicto = () => Object.assign(new Error('Deadlock, Update conflicts with concurrent update'), { gdscode: 335544451 });

  it('reconoce el conflicto por código y por texto, y no confunde otros errores', () => {
    assert.equal(esConflictoDeConcurrencia(conflicto()), true);
    assert.equal(esConflictoDeConcurrencia(Object.assign(new Error('x'), { gdscode: 335544336 })), true);
    assert.equal(esConflictoDeConcurrencia(new Error('deadlock')), true);
    assert.equal(esConflictoDeConcurrencia(new Error('lock time-out on wait transaction')), false, 'VFP la tuvo >10 s: no se insiste aquí');
    assert.equal(esConflictoDeConcurrencia(new Error('connection refused')), false);
    assert.equal(esConflictoDeConcurrencia(null), false);
  });

  function fbQue(fallos: Error[], folio = '0000152574') {
    const intentos: number[] = [];
    return {
      intentos,
      fb: {
        transaction: async (work: any) => {
          intentos.push(1);
          const error = fallos.shift();
          if (error) throw error;
          return work({ callScalar: async () => ({ FOLIO: folio }) });
        },
      },
    };
  }
  const sinEspera = { dormir: async () => {} };

  it('pierde el turno una vez y lo logra al reintentar, en una transacción NUEVA', async () => {
    const { fb, intentos } = fbQue([conflicto()]);
    assert.equal(await reservarFolioConReintentos(fb as any, 1, sinEspera), '0000152574');
    assert.equal(intentos.length, 2);
  });

  it('un error que NO es de concurrencia sube de inmediato, sin reintentos', async () => {
    const { fb, intentos } = fbQue([new Error('connection refused')]);
    await assert.rejects(() => reservarFolioConReintentos(fb as any, 1, sinEspera), /connection refused/);
    assert.equal(intentos.length, 1);
  });

  it('si la fila sigue ocupada tras todos los intentos, se rinde con un mensaje claro', async () => {
    const { fb, intentos } = fbQue(Array.from({ length: 20 }, conflicto));
    await assert.rejects(() => reservarFolioConReintentos(fb as any, 7, sinEspera), /la fila de la tienda 7 siguió ocupada/);
    assert.equal(intentos.length, REINTENTOS_RESERVA);
  });

  it('espera cada vez un poco más entre intentos (no martilla la fila)', async () => {
    const esperas: number[] = [];
    const { fb } = fbQue([conflicto(), conflicto(), conflicto()]);
    await reservarFolioConReintentos(fb as any, 1, { dormir: async (ms) => { esperas.push(ms); } });
    assert.equal(esperas.length, 3);
    assert.ok(esperas[0] >= 30 && esperas[1] >= 60 && esperas[2] >= 90, esperas.join(','));
  });
});
