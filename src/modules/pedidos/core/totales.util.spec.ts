import { Prisma } from '@prisma/client';
import { recalcularTotalesPedido } from './totales.util';

/**
 * Promo de volumen (sep 2026): el hook de re-evaluación dentro del recálculo.
 *
 * `recalcularTotalesPedido` es el chokepoint por el que pasan los CUATRO
 * caminos que mutan items de un pedido (mostrador, las dos ramas de propuesta
 * y el surtido de bodega). Estos tests fijan que el recálculo:
 *
 *   1. Suma el precio EFECTIVO de cada item, no el base — si no, el aviso del
 *      carrito ("ya tienes mayoreo") y el total cobrado divergirían.
 *   2. Re-evalúa la promo antes de sumar, así que un pedido que encogió pierde
 *      el mayoreo y uno que creció lo gana.
 *
 * Se mockea el `tx` y se capturan las escrituras, siguiendo el patrón de
 * `promo-volumen.spec.ts`.
 */

interface ItemFalso {
  id: number;
  cantidad: number;
  subtotal: Prisma.Decimal;
  precioUnitario: Prisma.Decimal;
  precioUnitarioBase: Prisma.Decimal | null;
  precioUnitarioMayoreo: Prisma.Decimal | null;
}

/** Item con par congelado y subtotal coherente con su precio efectivo. */
function item(
  id: number,
  cantidad: number,
  base: number,
  mayoreo: number,
  efectivo: number,
): ItemFalso {
  return {
    id,
    cantidad,
    subtotal: new Prisma.Decimal(efectivo).mul(cantidad),
    precioUnitario: new Prisma.Decimal(efectivo),
    precioUnitarioBase: new Prisma.Decimal(base),
    precioUnitarioMayoreo: new Prisma.Decimal(mayoreo),
  };
}

function crearTx(items: ItemFalso[]) {
  const updates: Array<{ id: number; subtotal: Prisma.Decimal }> = [];
  const pedidoActualizado: { data?: any } = {};

  // Estado vivo: `recalcularTotalesPedido` llama a `findMany` DOS veces (una
  // para re-evaluar la promo, otra para sumar). En Prisma real la segunda lee
  // lo que escribió la primera, así que el mock tiene que reflejar los updates
  // o la suma leería subtotales obsoletos y el test mediría el mock, no el
  // código.
  const estado = items.map((i) => ({ ...i }));

  const tx = {
    itemPedido: {
      findMany: jest.fn(async () => estado),
      update: jest.fn(async ({ where, data }: any) => {
        const fila = estado.find((i) => i.id === where.id);
        if (fila) {
          fila.subtotal = data.subtotal;
          if (data.precioUnitario) fila.precioUnitario = data.precioUnitario;
        }
        updates.push({ id: where.id, subtotal: data.subtotal });
        return data;
      }),
    },
    pedido: {
      update: jest.fn(async ({ data }: any) => {
        pedidoActualizado.data = data;
        return data;
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, updates, pedidoActualizado };
}

const pedidoBase = {
  id: 1,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

describe('recalcularTotalesPedido — promo de volumen', () => {
  it('suma el precio efectivo (mayoreo) cuando el pedido califica', async () => {
    // 12 piezas ya re-preciadas a 80. El subtotal del pedido debe ser 960,
    // no 1200 (que sería la suma de los subtotales base).
    const { tx, pedidoActualizado } = crearTx([item(1, 12, 100, 80, 80)]);

    const r = await recalcularTotalesPedido(tx, pedidoBase);

    expect(r.subtotal.toString()).toBe('960');
    expect(r.total.toString()).toBe('960');
    expect(pedidoActualizado.data.subtotal.toString()).toBe('960');
  });

  it('aplica la promo a un pedido que creció a 12', async () => {
    // Los items venían a precio base (100) y el pedido llegó a 12 piezas: el
    // recálculo los baja a 80 antes de sumar.
    const { tx, updates, pedidoActualizado } = crearTx([
      item(1, 5, 100, 80, 100),
      item(2, 7, 100, 80, 100),
    ]);

    const r = await recalcularTotalesPedido(tx, pedidoBase);

    expect(updates.map((u) => u.id).sort()).toEqual([1, 2]);
    expect(r.subtotal.toString()).toBe('960');
    expect(pedidoActualizado.data.total.toString()).toBe('960');
  });

  it('REVOCA la promo cuando el pedido encogió por debajo de 12', async () => {
    // El escenario de bodega: el pedido se creó con 12 y ganó el mayoreo;
    // el faltante dejó 5 piezas. Vuelven a su precio base.
    const { tx, updates, pedidoActualizado } = crearTx([item(1, 5, 100, 80, 80)]);

    const r = await recalcularTotalesPedido(tx, pedidoBase);

    expect(updates).toHaveLength(1);
    expect(r.subtotal.toString()).toBe('500');
    expect(pedidoActualizado.data.total.toString()).toBe('500');
  });

  it('respeta descuento e impuestos al calcular el total', async () => {
    // La promo baja el subtotal; descuento e impuestos se aplican ENCIMA, como
    // siempre. Fija que la promo no se cuela como un descuento paralelo.
    const { tx, pedidoActualizado } = crearTx([item(1, 12, 100, 80, 80)]);

    await recalcularTotalesPedido(tx, {
      id: 1,
      descuento: new Prisma.Decimal(60),
      impuestos: new Prisma.Decimal(10),
    });

    // 960 − 60 + 10
    expect(pedidoActualizado.data.total.toString()).toBe('910');
  });

  it('no toca los precios de un pedido anterior a la promo', async () => {
    const viejo: ItemFalso = {
      id: 1,
      cantidad: 20,
      subtotal: new Prisma.Decimal(2000),
      precioUnitario: new Prisma.Decimal(100),
      precioUnitarioBase: null,
      precioUnitarioMayoreo: null,
    };
    const { tx, updates, pedidoActualizado } = crearTx([viejo]);

    const r = await recalcularTotalesPedido(tx, pedidoBase);

    expect(updates).toHaveLength(0);
    expect(r.subtotal.toString()).toBe('2000');
    expect(pedidoActualizado.data.total.toString()).toBe('2000');
  });
});
