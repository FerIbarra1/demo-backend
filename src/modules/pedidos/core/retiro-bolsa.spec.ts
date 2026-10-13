import { EstadoSurtido, Prisma } from '@prisma/client';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import type { ItemPropuestaJson } from '../propuesta/dto/propuesta.dto';

/**
 * F19 (oct 2026): specs del retiro de mercancía de la bolsa.
 *
 * El caso que los motiva: el asesor quita un producto que bodega YA había
 * surtido completo. `quedanPendientes` da false — no hay nada que surtir — así
 * que el pedido iba directo a mostrador con la prenda de más todavía dentro de
 * la bolsa, y bodega nunca se enteraba porque su checklist de retiro sólo se
 * alimenta de pedidos en EN_REVISION.
 *
 * `huboRetiro` es la señal que faltaba. Es distinta de `quedanPendientes`:
 * `quedanPendientes` mira el estado FINAL (¿hay algo por surtir?), `huboRetiro`
 * mira si hubo que SACAR algo que ya estaba apartado.
 *
 * El fake de `tx` implementa sólo lo que el util usa: `itemPedido.findUnique`,
 * `itemPedido.update`, `itemPedido.create`, `itemPedido.count`, `precioCO.findUnique`.
 */
function fakeTx(items: Array<Record<string, unknown>>) {
  const store = new Map<number, Record<string, unknown>>(
    items.map((i) => [i.id as number, { ...i }]),
  );
  let nextId = 1000;

  const tx = {
    itemPedido: {
      findUnique: async ({ where }: { where: { id: number } }) => {
        const it = store.get(where.id);
        return it ? { ...it } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const it = store.get(where.id);
        if (!it) throw new Error(`item ${where.id} no existe`);
        Object.assign(it, data);
        return { ...it };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const creado = { id: nextId++, cancelada: false, ...data };
        store.set(creado.id as number, creado);
        return creado;
      },
      // `quedanPendientes` se calcula con un count de los items vivos que NO
      // están en COMPLETO, así que el fake tiene que respetar ese filtro: si lo
      // ignorara, un item ya cerrado contaría como pendiente y el test pasaría
      // por la razón equivocada.
      count: async ({
        where,
      }: {
        where: {
          cancelada?: boolean;
          estadoSurtido?: { not: EstadoSurtido };
        };
      }) =>
        Array.from(store.values()).filter((i) => {
          if (i.cancelada !== (where.cancelada ?? false)) return false;
          if (where.estadoSurtido?.not != null) {
            return i.estadoSurtido !== where.estadoSurtido.not;
          }
          return true;
        }).length,
      // `recalcularTotalesPedido` (que corre al final del util) lista los items
      // vivos para sumar subtotales y re-evaluar la promo de volumen.
      findMany: async ({ where }: { where: { pedidoId?: number; cancelada?: boolean } }) =>
        Array.from(store.values()).filter(
          (i) =>
            (where.pedidoId == null || i.pedidoId === where.pedidoId) &&
            i.cancelada === (where.cancelada ?? false),
        ),
    },
    precioCO: {
      findUnique: async () => ({
        id: 55,
        tiendaId: 1,
        producto: { nombre: 'Camiseta Nueva', codigo: 'C0300' },
        corrida: { nombre: 'Adulto Unisex' },
        talla: { nombre: 'M' },
        color: { nombre: 'Gris' },
        precio: new Prisma.Decimal(100),
        lista1: new Prisma.Decimal(100),
        lista2: new Prisma.Decimal(80),
        lista3: new Prisma.Decimal(70),
        lista4: new Prisma.Decimal(70),
        lista5: new Prisma.Decimal(70),
        lista6: new Prisma.Decimal(70),
      }),
    },
    pedido: {
      update: async () => ({}),
    },
  };
  return { tx: tx as never, store };
}

const pedido = {
  id: 1,
  tiendaId: 1,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

/**
 * Un segundo item que NO se toca, para que el pedido no quede vacío.
 *
 * `aplicarPropuestaDeVentas` tiene un guard legítimo: una propuesta que dejaría
 * el pedido sin productos se rechaza (hay que cancelar el pedido, no aprobarlo).
 * Los casos que quitan el item 1 necesitan que sobre algo.
 */
function itemRelleno() {
  return {
    id: 2,
    pedidoId: 1,
    cantidad: 2,
    cantidadPedida: 2,
    cantidadSurtida: 2,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    precioUnitarioBase: new Prisma.Decimal(100),
    precioUnitarioMayoreo: new Prisma.Decimal(80),
    subtotal: new Prisma.Decimal(200),
  };
}

/** Un item que bodega surtió COMPLETO: 5 pedidas, 5 apartadas. */
function itemCompleto(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 5,
    cantidadPedida: 5,
    cantidadSurtida: 5,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    precioUnitarioBase: new Prisma.Decimal(100),
    precioUnitarioMayoreo: new Prisma.Decimal(80),
    subtotal: new Prisma.Decimal(500),
    ...over,
  };
}

describe('aplicarPropuestaDeVentas — huboRetiro', () => {
  it('quitar un item que estaba COMPLETO marca huboRetiro', async () => {
    const { tx } = fakeTx([itemCompleto(), itemRelleno()]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'no-disponible', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 500 },
      { itemId: 2, tipo: 'completo', producto: 'Camiseta', variante: 'L', cantidad: 2, precioUnitario: 100, subtotal: 200 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [
        { id: 1, precioUnitario: new Prisma.Decimal(100) },
        { id: 2, precioUnitario: new Prisma.Decimal(100) },
      ],
      'lista1',
    );

    expect(r.huboRetiro).toBe(true);
    // No queda nada por surtir: sin `huboRetiro` el pedido iría directo a
    // mostrador con la prenda de más en la bolsa.
    expect(r.quedanPendientes).toBe(false);
  });

  it('quitar un item que NO estaba apartado no marca huboRetiro', async () => {
    const { tx } = fakeTx([
      itemCompleto({
        cantidadSurtida: 0,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
        subtotal: new Prisma.Decimal(0),
      }),
      itemRelleno(),
    ]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'no-disponible', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 0 },
      { itemId: 2, tipo: 'completo', producto: 'Camiseta', variante: 'L', cantidad: 2, precioUnitario: 100, subtotal: 200 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [
        { id: 1, precioUnitario: new Prisma.Decimal(100) },
        { id: 2, precioUnitario: new Prisma.Decimal(100) },
      ],
      'lista1',
    );

    // Nunca hubo piezas en la bolsa: no hay nada que sacar.
    expect(r.huboRetiro).toBe(false);
  });

  it('bajar la cantidad por debajo de lo apartado marca huboRetiro', async () => {
    const { tx } = fakeTx([itemCompleto()]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'parcial', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 500, cantidadNueva: 2 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    // Bodega apartó 5 y sólo se van a llevar 2: el sobrante vuelve al anaquel.
    expect(r.huboRetiro).toBe(true);
  });

  it('subir la cantidad no marca huboRetiro: no hay nada que sacar de la bolsa', async () => {
    const { tx } = fakeTx([itemCompleto()]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'parcial', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 500, cantidadNueva: 8 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(r.huboRetiro).toBe(false);
    // Subir sí deja trabajo: bodega tiene que verificar las piezas nuevas.
    expect(r.quedanPendientes).toBe(true);
  });

  it('cambiar un producto que estaba apartado marca huboRetiro', async () => {
    const { tx } = fakeTx([itemCompleto()]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'cambio', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 500, cantidadNueva: 5, precioCOId: 55 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    expect(r.huboRetiro).toBe(true);
  });

  it('agregar un producto no marca huboRetiro', async () => {
    const { tx } = fakeTx([itemCompleto()]);
    const propuesta: ItemPropuestaJson[] = [
      { itemId: 1, tipo: 'completo', producto: 'Camiseta', variante: 'M', cantidad: 5, precioUnitario: 100, subtotal: 500 },
      { itemId: -1, tipo: 'agregado', producto: 'Camiseta Nueva', variante: 'M · Gris', cantidad: 3, precioUnitario: 100, subtotal: 300, precioCOId: 55, tempId: -1 },
    ];

    const r = await aplicarPropuestaDeVentas(
      tx,
      pedido,
      propuesta,
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'lista1',
    );

    // Se AGREGA mercancía, no se retira: la bolsa no pierde nada.
    expect(r.huboRetiro).toBe(false);
    expect(r.quedanPendientes).toBe(true);
  });
});
