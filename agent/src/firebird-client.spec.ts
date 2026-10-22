import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { primeraFila } from './firebird-client';

/**
 * `GRABAR_PEDIDOS`/`GRABAR_MOVPED` son procedimientos EJECUTABLES: `EXECUTE PROCEDURE` devuelve UN objeto con los
 * parámetros de salida, no un arreglo de filas (se comprobó contra Firebird 3.0.10). El agente solo sabía leer arreglos.
 */
describe('primeraFila', () => {
  it('de un arreglo de filas (SELECT) toma la primera', () => {
    assert.deepEqual(primeraFila([{ A: 1 }, { A: 2 }]), { A: 1 });
  });
  it('de un objeto (EXECUTE PROCEDURE) lo devuelve tal cual', () => {
    assert.deepEqual(primeraFila({ PEDIDO_ID: 7, PEDIDO_FOLIO: 'X ' }), { PEDIDO_ID: 7, PEDIDO_FOLIO: 'X ' });
  });
  it('sin resultado devuelve null', () => {
    assert.equal(primeraFila([]), null);
    assert.equal(primeraFila(undefined), null);
    assert.equal(primeraFila(null), null);
  });
});
