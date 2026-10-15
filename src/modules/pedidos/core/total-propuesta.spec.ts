import { EstadoSurtido, Prisma } from '@prisma/client';
import { totalDePropuesta, lineaSobrevive, type LineaFinal } from './total-propuesta.util';
import { construirPropuestaDeBodega } from './propuesta-bodega.util';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';

/**
 * F20 (oct 2026): el total de una propuesta tiene que salir de la MISMA regla
 * que el cobro.
 *
 * Los dos bugs que estos tests fijan, ambos del mismo error de fondo (mostrar
 * un número que no sale de la función que cobra):
 *
 *   1. Se sumaban las líneas que la propuesta QUITA. Un `no-disponible` trae el
 *      subtotal de la cantidad PEDIDA, así que inflaba el total.
 *   2. Se usaba el precio CONGELADO en el item, pero el cobro lo RE-EVALÚA
 *      (`aplicarPromoVolumen`). La promo de volumen se revoca al bajar de 12.
 *
 * Los casos usan un cliente de lista 1 (base $100, mayoreo $80) — el único que
 * la promo puede beneficiar.
 */

const BASE = new Prisma.Decimal(100);
const MAYOREO = new Prisma.Decimal(80);

/** El cobro REAL: modelo exacto de `aplicarCambiosFisicos` + `aplicarPromoVolumen`. */
function cobroReal(
  items: Array<{ estadoSurtido: EstadoSurtido; cantidad: number; cantidadSurtida: number }>,
): number {
  const tras: Array<{ cancelada: boolean; cantidad: number }> = items.map((i) => {
    if (i.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) {
      return { cancelada: true, cantidad: i.cantidad };
    }
    if (i.estadoSurtido === EstadoSurtido.PARCIAL) {
      return { cancelada: false, cantidad: i.cantidadSurtida };
    }
    return { cancelada: false, cantidad: i.cantidad };
  });
  const vivos = tras.filter((i) => !i.cancelada);
  const piezas = vivos.reduce((a, i) => a + i.cantidad, 0);
  return Number(precioConPromoVolumen(BASE, MAYOREO, piezas)) * piezas;
}

/** Item de pedido con el par de precios congelado (nació con 12+ piezas). */
function item(id: number, pedida: number, vigente: number, surtida: number, estado: EstadoSurtido) {
  const precio = new Prisma.Decimal(80);
  return {
    id,
    productoNombre: `P${id}`,
    productoCodigo: `C${id}`,
    corridaNombre: 'A',
    tallaNombre: 'M',
    colorNombre: 'N',
    cantidadPedida: pedida,
    cantidad: vigente,
    cantidadSurtida: surtida,
    estadoSurtido: estado,
    cancelada: false,
    precioUnitario: precio,
    precioUnitarioBase: BASE,
    precioUnitarioMayoreo: MAYOREO,
    subtotal: precio.mul(vigente),
  };
}

// =============================================================================
// El util puro
// =============================================================================

describe('totalDePropuesta — la regla compartida', () => {
  it('no suma una línea que sale del pedido', () => {
    const lineas: LineaFinal[] = [
      { cantidad: 10, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
    ];
    // 10 piezas → bajo el umbral → precio base $100.
    expect(totalDePropuesta(lineas)).toBe(1000);
  });

  it('decide la promo con el total FINAL, no con el acumulado parcial', () => {
    // Dos líneas de 6: por separado ninguna llega a 12, juntas sí.
    const lineas: LineaFinal[] = [
      { cantidad: 6, base: BASE, mayoreo: MAYOREO, precioUnitario: 100 },
      { cantidad: 6, base: BASE, mayoreo: MAYOREO, precioUnitario: 100 },
    ];
    // 12 piezas → mayoreo $80 → 960. Si resolviera en una pasada daría
    // mezclados (6×100 + 6×80 = 1080).
    expect(totalDePropuesta(lineas)).toBe(960);
  });

  it('sin par congelado usa el precio del item (pedidos viejos)', () => {
    const lineas: LineaFinal[] = [
      { cantidad: 10, base: null, mayoreo: null, precioUnitario: 100 },
    ];
    expect(totalDePropuesta(lineas)).toBe(1000);
  });

  it('un pedido donde TODO sale da 0, no el total original', () => {
    const lineas: LineaFinal[] = [
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
    ];
    expect(totalDePropuesta(lineas)).toBe(0);
  });

  it('lineaSobrevive: solo `no-disponible` saca la línea', () => {
    expect(lineaSobrevive('completo')).toBe(true);
    expect(lineaSobrevive('parcial')).toBe(true);
    expect(lineaSobrevive('agregado')).toBe(true);
    // `cambio` sobrevive: reemplaza el original por otro producto.
    expect(lineaSobrevive('cambio')).toBe(true);
    expect(lineaSobrevive('no-disponible')).toBe(false);
  });
});

// =============================================================================
// El camino de BODEGA, contra el cobro real
// =============================================================================

describe('construirPropuestaDeBodega — el total coincide con el cobro', () => {
  function revisar(items: any[]): { propuesta: number; cobro: number } {
    const { total } = construirPropuestaDeBodega(items as never);
    return { propuesta: total, cobro: cobroReal(items) };
  }

  it('un producto agotado que baja el pedido de 12 a 10 (antes $800 vs $1000)', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1000);
    expect(propuesta).toBe(cobro);
  });

  it('un parcial que baja el pedido de 12 a 11 (antes $900 vs $1100)', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 1, EstadoSurtido.PARCIAL),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1100);
    expect(propuesta).toBe(cobro);
  });

  it('un item colapsado por bodega (20 pedidas, 10 hay)', () => {
    const items = [item(1, 20, 10, 10, EstadoSurtido.COMPLETO)];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1000);
    expect(propuesta).toBe(cobro);
  });

  it('un parcial que CONSERVA las 12 piezas mantiene la promo', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 4, 4, 2, EstadoSurtido.PARCIAL),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(960);
    expect(propuesta).toBe(cobro);
  });

  it('16 pedidas que quedan en 14 conservan la promo', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 4, 4, 4, EstadoSurtido.COMPLETO),
      item(3, 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ];
    const { propuesta, cobro } = revisar(items);
    // 14 piezas siguen sobre el umbral: la promo se mantiene a $80.
    expect(propuesta).toBe(1120);
    expect(propuesta).toBe(cobro);
  });

  it('un pedido intacto de 12+ no cambia de precio', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 2, EstadoSurtido.COMPLETO),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(960);
    expect(propuesta).toBe(cobro);
  });
});
