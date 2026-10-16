import { EstadoSurtido } from '@prisma/client';
import { ajusteNecesitaBodega } from './ajuste-cantidad.util';

/**
 * Oct 2026 (propuestas, decisión 4): ¿el ajuste de mostrador tiene algo que bodega
 * deba surtir? Si no, el pedido se resuelve en el lugar y lo quitado pasa a
 * reposición; si sí, viaja a bodega.
 *
 * Es la misma vara que `piezasPorSurtir` de la calculadora del editor (lo que
 * excede las piezas en la bolsa): el frontend la lee para decirle al operador, ANTES
 * de enviar, qué va a pasar con el pedido.
 */

function linea(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    cantidad: 10,
    cantidadSurtida: 10,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    ...over,
  } as Parameters<typeof ajusteNecesitaBodega>[0][number];
}

describe('ajusteNecesitaBodega', () => {
  it('quitar una línea no necesita bodega', () => {
    expect(
      ajusteNecesitaBodega(
        [linea({ id: 1 }), linea({ id: 2 })],
        [{ tipo: 'no-disponible', itemId: 1 }],
      ),
    ).toBe(false);
  });

  it('bajar la cantidad no necesita bodega', () => {
    expect(
      ajusteNecesitaBodega([linea({ id: 1 })], [{ tipo: 'parcial', itemId: 1, cantidad: 4 }]),
    ).toBe(false);
  });

  it('subir DENTRO de lo que hay en la bolsa tampoco: ya está verificado', () => {
    // Había 10, el cliente pidió 6 y ahora quiere 8: las 8 están en la bolsa.
    expect(
      ajusteNecesitaBodega(
        [linea({ id: 1, cantidad: 6 })],
        [{ tipo: 'parcial', itemId: 1, cantidad: 8 }],
      ),
    ).toBe(false);
  });

  it('subir por ENCIMA de lo que hay en la bolsa necesita bodega', () => {
    expect(
      ajusteNecesitaBodega([linea({ id: 1 })], [{ tipo: 'parcial', itemId: 1, cantidad: 11 }]),
    ).toBe(true);
  });

  it('descuenta lo que un ajuste anterior ya sacó de la bolsa', () => {
    // Se encontraron 5, salieron 2 (en la bolsa 3) y ahora quiere 4: las 2 que
    // salieron ya están en el anaquel, así que hay una pieza que nadie verificó.
    expect(
      ajusteNecesitaBodega(
        [linea({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 })],
        [{ tipo: 'parcial', itemId: 1, cantidad: 4 }],
      ),
    ).toBe(true);
  });

  it('agregar un producto necesita bodega', () => {
    expect(ajusteNecesitaBodega([linea({ id: 1 })], [{ tipo: 'agregado', cantidad: 2 }])).toBe(
      true,
    );
  });

  it('una línea "completo" no cuenta como cambio', () => {
    expect(
      ajusteNecesitaBodega(
        [linea({ id: 1 }), linea({ id: 2 })],
        [
          { tipo: 'completo', itemId: 1 },
          { tipo: 'no-disponible', itemId: 2 },
        ],
      ),
    ).toBe(false);
  });

  it('una línea PENDIENTE sin tocar obliga a pasar por bodega', () => {
    // Quedarse en el área de entrega la mandaría al ERP cobrando mercancía que
    // bodega nunca vio.
    expect(
      ajusteNecesitaBodega(
        [
          linea({ id: 1 }),
          linea({ id: 2, cantidad: 3, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE }),
        ],
        [{ tipo: 'no-disponible', itemId: 1 }],
      ),
    ).toBe(true);
  });

  it('quitar la línea PENDIENTE sí la saca de la cuenta', () => {
    expect(
      ajusteNecesitaBodega(
        [
          linea({ id: 1 }),
          linea({ id: 2, cantidad: 3, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE }),
        ],
        [{ tipo: 'no-disponible', itemId: 2 }],
      ),
    ).toBe(false);
  });

  it('las líneas ya canceladas no cuentan', () => {
    expect(
      ajusteNecesitaBodega(
        [linea({ id: 1 }), linea({ id: 2, cancelada: true, cantidadSurtida: 0, cantidad: 5 })],
        [{ tipo: 'parcial', itemId: 1, cantidad: 2 }],
      ),
    ).toBe(false);
  });

  it('usa el mismo piso de 1 que aplicarAjuste cuando la cantidad no viene', () => {
    expect(ajusteNecesitaBodega([linea({ id: 1 })], [{ tipo: 'parcial', itemId: 1 }])).toBe(false);
  });
});
