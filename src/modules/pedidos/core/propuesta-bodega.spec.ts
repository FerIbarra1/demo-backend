import { EstadoSurtido, Prisma } from '@prisma/client';
import { construirPropuestaDeBodega, type ItemParaPropuesta } from './propuesta-bodega.util';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';

/**
 * F19 (oct 2026): specs de la propuesta que bodega genera al cerrar el surtido.
 *
 * Antes NO había ni un solo test sobre `construirPropuestaDeBodega`, y eso dejó
 * pasar dos bugs que llegaron a producción:
 *
 *   1. La propuesta salía SIN imágenes (la de ventas sí las traía, porque el
 *      frontend se las metía al armar su borrador).
 *   2. El `total` de la propuesta no coincidía con el total que se cobraba,
 *      cuando el faltante hacía perder la promo de volumen.
 *
 * El segundo es el que importa: es dinero.
 */

/** Item base: 20 pedidas, 10 surtidas (el caso del reporte). */
function item(over: Partial<ItemParaPropuesta> = {}): ItemParaPropuesta {
  return {
    id: 1,
    productoNombre: 'Camiseta',
    productoCodigo: 'C0200',
    productoImagen: 'https://cdn/azul.jpg',
    productoId: 7,
    corridaNombre: 'Adulto Unisex',
    tallaNombre: 'M',
    colorNombre: 'Marino',
    cantidadPedida: 20,
    cantidad: 10,
    cantidadSurtida: 10,
    estadoSurtido: EstadoSurtido.PARCIAL,
    precioUnitario: new Prisma.Decimal(100),
    precioUnitarioBase: new Prisma.Decimal(100),
    precioUnitarioMayoreo: new Prisma.Decimal(80),
    subtotal: new Prisma.Decimal(1000),
    cancelada: false,
    ...over,
  };
}

describe('construirPropuestaDeBodega — cantidades', () => {
  it('un PARCIAL reporta la cantidad PEDIDA como referencia, no la surtida', () => {
    const { items } = construirPropuestaDeBodega([item()]);

    expect(items).toHaveLength(1);
    expect(items[0].tipo).toBe('parcial');
    // El bug del reporte: `cantidad` salía con lo surtido (10) y el cliente veía
    // "Sin cambios" en un pedido del que pidió 20.
    expect(items[0].cantidad).toBe(20);
    expect(items[0].cantidadOriginal).toBe(20);
    expect(items[0].cantidadNueva).toBe(10);
  });

  it('un NO_DISPONIBLE reporta la cantidad pedida, no 0', () => {
    const { items } = construirPropuestaDeBodega([
      item({ estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0, subtotal: new Prisma.Decimal(0) }),
    ]);

    expect(items[0].tipo).toBe('no-disponible');
    expect(items[0].cantidad).toBe(20);
  });

  it('un COMPLETO que coincide con lo pedido no inventa un delta', () => {
    const { items } = construirPropuestaDeBodega([
      item({ cantidad: 20, cantidadSurtida: 20, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    expect(items[0].tipo).toBe('completo');
    expect(items[0].cantidad).toBe(20);
    expect(items[0].cantidadNueva).toBeUndefined();
  });
});

describe('construirPropuestaDeBodega — imágenes', () => {
  it('la imagen del item viaja al snapshot', () => {
    const { items } = construirPropuestaDeBodega([item()]);

    // El bug: la propuesta de bodega salía con el placeholder de iniciales
    // porque el snapshot no llevaba ni `productoImagen` ni `productoId`.
    expect(items[0].productoImagen).toBe('https://cdn/azul.jpg');
    expect(items[0].productoId).toBe(7);
  });

  it('sin imagen en el item, el snapshot queda en null (el front cae al placeholder)', () => {
    const { items } = construirPropuestaDeBodega([
      item({ productoImagen: null, productoId: null }),
    ]);

    expect(items[0].productoImagen).toBeNull();
    expect(items[0].productoId).toBeUndefined();
  });
});

describe('construirPropuestaDeBodega — el total que se aprueba es el que se cobra', () => {
  /**
   * Simula lo que hará `recalcularTotalesPedido` al aprobar: aplica los cambios
   * físicos (colapsa los PARCIAL a lo surtido) y re-evalúa la promo con el
   * tamaño FINAL del pedido. Es el número que se le va a cobrar al cliente.
   */
  function totalQueSeCobra(items: ItemParaPropuesta[]): number {
    const activos = items.filter(
      (i) => !i.cancelada && i.estadoSurtido !== EstadoSurtido.NO_DISPONIBLE,
    );
    const cantidadFinal = (i: ItemParaPropuesta) =>
      i.estadoSurtido === EstadoSurtido.PARCIAL ? i.cantidadSurtida : i.cantidad;

    const totalPiezas = activos.reduce((acc, i) => acc + cantidadFinal(i), 0);
    return activos.reduce((acc, i) => {
      const base = new Prisma.Decimal(i.precioUnitarioBase ?? i.precioUnitario);
      const mayoreo = new Prisma.Decimal(i.precioUnitarioMayoreo ?? base);
      const precio = precioConPromoVolumen(base, mayoreo, totalPiezas);
      return acc + Number(precio) * cantidadFinal(i);
    }, 0);
  }

  it('EL BUG DE $200: un pedido de menudeo que baja de 12 piezas pierde la promo, y la propuesta lo refleja', () => {
    // 12 piezas de lista 1 (base $100, mayoreo $80). Con 12 piezas la promo
    // aplica; bodega sólo tiene 10, así que el pedido baja del umbral.
    const items = [
      item({
        id: 1,
        cantidadPedida: 12,
        cantidad: 10,
        cantidadSurtida: 10,
        estadoSurtido: EstadoSurtido.PARCIAL,
        precioUnitario: new Prisma.Decimal(80), // precio VIEJO, con promo aplicada
        subtotal: new Prisma.Decimal(960), // 12 × 80
      }),
    ];

    const { total } = construirPropuestaDeBodega(items);

    // Antes: 10 × $80 = $800 (el precio viejo, con promo) y se cobraban $1000.
    expect(total).toBe(1000);
    expect(total).toBe(totalQueSeCobra(items));
  });

  it('un cliente de lista 3 no se ve afectado: su base ya es más barata que el mayoreo', () => {
    // lista 3: base $70, mayoreo (lista 2) $80. El `min` de la promo es su
    // propia lista, así que la promo nunca le encarece nada — ni con 12 ni con 10.
    const items = [
      item({
        id: 1,
        cantidadPedida: 12,
        cantidad: 10,
        cantidadSurtida: 10,
        estadoSurtido: EstadoSurtido.PARCIAL,
        precioUnitario: new Prisma.Decimal(70),
        precioUnitarioBase: new Prisma.Decimal(70),
        precioUnitarioMayoreo: new Prisma.Decimal(80),
        subtotal: new Prisma.Decimal(840),
      }),
    ];

    const { total } = construirPropuestaDeBodega(items);

    expect(total).toBe(700); // 10 × 70, sin cambio de precio
    expect(total).toBe(totalQueSeCobra(items));
  });

  it('un pedido que se queda en 12+ piezas conserva la promo en la propuesta', () => {
    const items = [
      item({
        id: 1,
        cantidadPedida: 10,
        cantidad: 10,
        cantidadSurtida: 10,
        estadoSurtido: EstadoSurtido.COMPLETO,
        precioUnitario: new Prisma.Decimal(80),
        subtotal: new Prisma.Decimal(800),
      }),
      item({
        id: 2,
        cantidadPedida: 2,
        cantidad: 2,
        cantidadSurtida: 2,
        estadoSurtido: EstadoSurtido.COMPLETO,
        precioUnitario: new Prisma.Decimal(80),
        subtotal: new Prisma.Decimal(160),
      }),
    ];

    const { total } = construirPropuestaDeBodega(items);

    expect(total).toBe(960); // 12 × 80, promo vigente
    expect(total).toBe(totalQueSeCobra(items));
  });

  it('un pedido anterior a la promo (sin par congelado) no se toca', () => {
    const items = [
      item({
        id: 1,
        cantidadPedida: 12,
        cantidad: 10,
        cantidadSurtida: 10,
        estadoSurtido: EstadoSurtido.PARCIAL,
        precioUnitario: new Prisma.Decimal(100),
        precioUnitarioBase: null,
        precioUnitarioMayoreo: null,
        subtotal: new Prisma.Decimal(1200),
      }),
    ];

    const { total } = construirPropuestaDeBodega(items);

    expect(total).toBe(1000); // 10 × 100, sin promo que aplicar
    expect(total).toBe(totalQueSeCobra(items));
  });

  it('el total de la propuesta cuadra con el cobro en un pedido mixto', () => {
    const items = [
      // Se queda completo.
      item({ id: 1, cantidadPedida: 6, cantidad: 6, cantidadSurtida: 6, estadoSurtido: EstadoSurtido.COMPLETO, subtotal: new Prisma.Decimal(600) }),
      // Baja de 8 a 4: el pedido pasa de 14 a 10 piezas y pierde la promo.
      item({ id: 2, cantidadPedida: 8, cantidad: 4, cantidadSurtida: 4, estadoSurtido: EstadoSurtido.PARCIAL, subtotal: new Prisma.Decimal(640) }),
      // No hay nada.
      item({ id: 3, cantidadPedida: 3, cantidad: 3, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, subtotal: new Prisma.Decimal(300) }),
    ];

    const { total } = construirPropuestaDeBodega(items);

    // 10 piezas finales (< 12) → sin promo: 10 × 100 = 1000.
    expect(total).toBe(1000);
    expect(total).toBe(totalQueSeCobra(items));
  });
});
