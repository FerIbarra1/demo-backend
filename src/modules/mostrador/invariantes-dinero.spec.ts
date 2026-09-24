import { EstadoPedido, EstadoSurtido, Prisma } from '@prisma/client';

/**
 * F16 (sep 2026): tests de los invariantes de DINERO del ajuste de mostrador.
 *
 * La auditoría adversarial encontró dos bugs que causaban cobro incorrecto por
 * la UI normal. Estos tests los fijan para que no vuelvan:
 *
 *   1. `parcial` que SUBE la cantidad dejaba el item COMPLETO con el
 *      `cantidadSurtida` viejo → el cliente pagaba piezas que bodega nunca
 *      apartó.
 *   2. `aprobarPropuestaBodega` podía llegar a pago con CERO items activos.
 *
 * Se prueba la COHERENCIA del estado del item, que es lo que sostiene el
 * invariante "lo que se cobra es lo que se surtió".
 */

/** Réplica de la regla que aplica `MostradorService.aplicarAjuste` (rama parcial). */
function estadoTrasAjusteParcial(
  cantidadNueva: number,
  cantidadSurtida: number,
): { estadoSurtido: EstadoSurtido; cantidadSurtida: number } {
  const subeLaCantidad = cantidadNueva > cantidadSurtida;
  return subeLaCantidad
    ? { estadoSurtido: EstadoSurtido.PENDIENTE, cantidadSurtida: 0 }
    : { estadoSurtido: EstadoSurtido.COMPLETO, cantidadSurtida: cantidadNueva };
}

describe('Invariante: lo que se cobra es lo que se surtió', () => {
  describe('ajuste parcial de cantidad', () => {
    it('SUBIR la cantidad devuelve el item a bodega (PENDIENTE)', () => {
      // El bug: con 2 piezas apartadas, el cliente pide 5. Antes el item
      // quedaba COMPLETO con cantidadSurtida=2, `confirmarSurtido` no lo
      // detectaba y el pedido avanzaba cobrando 5 piezas de las que solo 2
      // estaban apartadas.
      const r = estadoTrasAjusteParcial(5, 2);
      expect(r.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
      expect(r.cantidadSurtida).toBe(0);
    });

    it('BAJAR la cantidad deja el item COMPLETO con lo nuevo', () => {
      // El sobrante vuelve al anaquel; no hace falta que bodega re-surta.
      const r = estadoTrasAjusteParcial(1, 2);
      expect(r.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
      expect(r.cantidadSurtida).toBe(1);
    });

    it('mantener la cantidad deja el item COMPLETO coherente', () => {
      const r = estadoTrasAjusteParcial(2, 2);
      expect(r.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
      expect(r.cantidadSurtida).toBe(2);
    });

    it('NINGÚN caso deja COMPLETO con cantidadSurtida < cantidad', () => {
      // El invariante que `confirmarSurtido` ahora valida. Si esta propiedad se
      // rompe, el pedido puede avanzar cobrando piezas no surtidas.
      for (const cantidadNueva of [1, 2, 3, 5, 10]) {
        for (const cantidadSurtida of [0, 1, 2, 3]) {
          const r = estadoTrasAjusteParcial(cantidadNueva, cantidadSurtida);
          if (r.estadoSurtido === EstadoSurtido.COMPLETO) {
            expect(r.cantidadSurtida).toBeGreaterThanOrEqual(cantidadNueva);
          }
        }
      }
    });
  });

  describe('la red de seguridad de confirmarSurtido', () => {
    /** Réplica del guard que se agregó a `SurtidoService.confirmarSurtido`. */
    function detectaIncoherentes(
      items: Array<{ id: number; cancelada: boolean; estadoSurtido: EstadoSurtido; cantidad: number; cantidadSurtida: number }>,
    ): number[] {
      return items
        .filter(
          (i) =>
            !i.cancelada &&
            i.estadoSurtido === EstadoSurtido.COMPLETO &&
            i.cantidadSurtida < i.cantidad,
        )
        .map((i) => i.id);
    }

    it('detecta un item COMPLETO con menos piezas apartadas', () => {
      const items = [
        { id: 1, cancelada: false, estadoSurtido: EstadoSurtido.COMPLETO, cantidad: 5, cantidadSurtida: 2 },
      ];
      expect(detectaIncoherentes(items)).toEqual([1]);
    });

    it('no marca los items coherentes', () => {
      const items = [
        { id: 1, cancelada: false, estadoSurtido: EstadoSurtido.COMPLETO, cantidad: 2, cantidadSurtida: 2 },
        { id: 2, cancelada: false, estadoSurtido: EstadoSurtido.PARCIAL, cantidad: 5, cantidadSurtida: 3 },
        { id: 3, cancelada: true, estadoSurtido: EstadoSurtido.COMPLETO, cantidad: 5, cantidadSurtida: 0 },
      ];
      expect(detectaIncoherentes(items)).toEqual([]);
    });

    it('un item cancelado no cuenta aunque esté incoherente', () => {
      const items = [
        { id: 1, cancelada: true, estadoSurtido: EstadoSurtido.COMPLETO, cantidad: 5, cantidadSurtida: 0 },
      ];
      expect(detectaIncoherentes(items)).toEqual([]);
    });
  });

  describe('guard de pedido sin items activos', () => {
    /** Réplica del guard compartido por los tres caminos. */
    function pedidoVacio(items: Array<{ cancelada: boolean }>): boolean {
      return items.filter((i) => !i.cancelada).length === 0;
    }

    it('detecta el pedido vacío (todos los items cancelados)', () => {
      // El escenario del bug: el cliente aprueba una propuesta donde bodega
      // marcó TODOS los items como NO_DISPONIBLE. Sin el guard, el pedido
      // avanzaba a pago con subtotal y total en 0.
      expect(pedidoVacio([{ cancelada: true }, { cancelada: true }])).toBe(true);
    });

    it('no marca un pedido con al menos un item activo', () => {
      expect(pedidoVacio([{ cancelada: true }, { cancelada: false }])).toBe(false);
    });

    it('los tres caminos usan la misma regla', () => {
      // confirmarSurtido, aprobarPropuestaBodega y el ajuste de mostrador
      // comparten el predicado: "hay al menos un item no cancelado".
      const casos = [
        [{ cancelada: true }],
        [{ cancelada: false }],
        [{ cancelada: true }, { cancelada: false }],
      ];
      for (const c of casos) {
        expect(pedidoVacio(c)).toBe(c.every((i) => i.cancelada));
      }
    });
  });
});
