import { Prisma } from '@prisma/client';
import {
  columnaDesdeCodigo,
  resolverColumnaLista,
  precioDeLista,
  precioConPromoVolumen,
  PIEZAS_MAYOREO,
  ColumnaLista,
} from './precio-lista.util';

/**
 * Fase 0 (sep 2026): tests de la resolución de lista de precios.
 *
 * Estos tests son el guard de regresión del bug que motivó la fase: el pedido
 * se creaba con `PrecioCO.precio` (siempre lista1) aunque el cliente tuviera
 * otra lista. Las dos reglas que NO pueden divergir entre catálogo y pedido
 * son exactamente las que cubren estos tests.
 */

/** PrecioCO de prueba con precios distintos por lista, para detectar cruces. */
function pco(overrides: Partial<Record<ColumnaLista | 'precio', number>> = {}) {
  return {
    precio: 100,
    lista1: 100,
    lista2: 200,
    lista3: 300,
    lista4: 400,
    lista5: 500,
    lista6: 600,
    ...overrides,
  };
}

describe('columnaDesdeCodigo', () => {
  it('mapea los códigos 2..6 a su columna', () => {
    expect(columnaDesdeCodigo('2')).toBe('lista2');
    expect(columnaDesdeCodigo('3')).toBe('lista3');
    expect(columnaDesdeCodigo('4')).toBe('lista4');
    expect(columnaDesdeCodigo('5')).toBe('lista5');
    expect(columnaDesdeCodigo('6')).toBe('lista6');
  });

  it('mapea el código 1 y los valores ausentes a lista1', () => {
    expect(columnaDesdeCodigo('1')).toBe('lista1');
    expect(columnaDesdeCodigo(null)).toBe('lista1');
    expect(columnaDesdeCodigo(undefined)).toBe('lista1');
    expect(columnaDesdeCodigo('')).toBe('lista1');
  });

  it('tolera espacios alrededor del código (Firebird CHAR)', () => {
    expect(columnaDesdeCodigo(' 3 ')).toBe('lista3');
    expect(columnaDesdeCodigo('3  ')).toBe('lista3');
  });

  it('cae a lista1 con un código desconocido', () => {
    expect(columnaDesdeCodigo('7')).toBe('lista1');
    expect(columnaDesdeCodigo('X')).toBe('lista1');
  });
});

describe('resolverColumnaLista', () => {
  it('la lista por tienda gana sobre la global', () => {
    expect(resolverColumnaLista('3', '5')).toBe('lista3');
  });

  it('cae a la global cuando no hay lista por tienda', () => {
    expect(resolverColumnaLista(null, '4')).toBe('lista4');
    expect(resolverColumnaLista(undefined, '4')).toBe('lista4');
  });

  it('cae a lista1 cuando no hay ninguna', () => {
    expect(resolverColumnaLista(null, null)).toBe('lista1');
    expect(resolverColumnaLista(undefined, undefined)).toBe('lista1');
  });

  it('un código por-tienda de cadena vacía se respeta como valor presente', () => {
    // `??` (no `||`): un '' por tienda NO debe caer a la global. Es el
    // comportamiento histórico y cambiarlo alteraría precios ya mostrados.
    expect(resolverColumnaLista('', '3')).toBe('lista1');
  });
});

describe('precioDeLista', () => {
  it('devuelve el precio de la lista indicada', () => {
    expect(precioDeLista(pco(), 'lista3').toString()).toBe('300');
    expect(precioDeLista(pco(), 'lista6').toString()).toBe('600');
  });

  it('NO devuelve lista1 cuando el cliente tiene otra lista', () => {
    // El bug original: el pedido se creaba con `pco.precio` (= lista1) aunque
    // el cliente tuviera lista 3.
    const precio = precioDeLista(pco(), 'lista3');
    expect(precio.toString()).not.toBe('100');
    expect(precio.toString()).toBe('300');
  });

  it('cae al precio base cuando la lista del cliente está en 0', () => {
    // Firebird puede tener listas sin capturar; cobrar 0 sería peor que
    // cobrar el precio base.
    const sinLista3 = pco({ lista3: 0 });
    expect(precioDeLista(sinLista3, 'lista3').toString()).toBe('100');
  });

  it('cae al precio base cuando la lista del cliente es null', () => {
    const sinLista4 = pco({ lista4: null as unknown as number });
    expect(precioDeLista(sinLista4, 'lista4').toString()).toBe('100');
  });

  it('devuelve Decimal, no number (sin error de punto flotante)', () => {
    const precio = precioDeLista(pco({ lista2: 33.33 }), 'lista2');
    expect(precio).toBeInstanceOf(Prisma.Decimal);
    // 33.33 * 3 debe ser exacto, no 99.99000000000001
    expect(precio.mul(3).toString()).toBe('99.99');
  });

  it('acepta Decimal, number y string como entrada', () => {
    const mixto = {
      precio: new Prisma.Decimal('100'),
      lista1: new Prisma.Decimal('100'),
      lista2: 200,
      lista3: '300',
      lista4: new Prisma.Decimal('400'),
      lista5: 500,
      lista6: 600,
    };
    expect(precioDeLista(mixto, 'lista2').toString()).toBe('200');
    expect(precioDeLista(mixto, 'lista3').toString()).toBe('300');
    expect(precioDeLista(mixto, 'lista4').toString()).toBe('400');
  });
});

describe('precioConPromoVolumen', () => {
  const d = (n: number) => new Prisma.Decimal(n);

  it('devuelve el precio base por debajo del umbral', () => {
    expect(precioConPromoVolumen(d(60), d(57), PIEZAS_MAYOREO - 1).toString()).toBe('60');
    expect(precioConPromoVolumen(d(60), d(57), 1).toString()).toBe('60');
    expect(precioConPromoVolumen(d(60), d(57), 0).toString()).toBe('60');
  });

  it('aplica el mayoreo justo en el umbral', () => {
    expect(precioConPromoVolumen(d(60), d(57), PIEZAS_MAYOREO).toString()).toBe('57');
  });

  it('NUNCA encarece a un cliente que ya tiene mejor precio', () => {
    // Las listas van de menudeo (1, caro) a mayoreo (6, barato). Para un
    // cliente de lista 3 (54) el mayoreo (57) es MÁS CARO: el mínimo conserva
    // su 54. La promo es un beneficio para el de menudeo, no un castigo.
    expect(precioConPromoVolumen(d(54), d(57), PIEZAS_MAYOREO).toString()).toBe('54');
    expect(precioConPromoVolumen(d(45), d(57), 500).toString()).toBe('45');
  });

  it('protege ante una lista2 mal capturada (más cara que la base)', () => {
    expect(precioConPromoVolumen(d(60), d(99), PIEZAS_MAYOREO).toString()).toBe('60');
  });

  it('es idempotente: aplicarla dos veces da el mismo resultado', () => {
    const una = precioConPromoVolumen(d(60), d(57), 20);
    const dos = precioConPromoVolumen(una, d(57), 20);
    expect(dos.toString()).toBe(una.toString());
    expect(una.toString()).toBe('57');
  });

  it('es punto fijo: el precio que congela la creación no cambia al re-evaluar', () => {
    // El invariante que sostiene todo: si el pedido se creó con este precio,
    // volver a aplicar la regla (lo que hace cada `recalcularTotalesPedido`)
    // tiene que dar EXACTAMENTE lo mismo. Si no, el pedido cambiaría de precio
    // solo, sin que nadie lo edite.
    for (const [base, mayoreo] of [
      [60, 57], // lista1 normal
      [54, 57], // lista3 con mayoreo más caro
      [60, 60], // lista2 sin capturar (fallback a base)
      [57, 57], // ambos iguales
    ]) {
      const congelado = precioConPromoVolumen(d(base), d(mayoreo), 12);
      const reevaluado = precioConPromoVolumen(congelado, d(mayoreo), 12);
      expect(reevaluado.toString()).toBe(congelado.toString());
    }
  });
});
