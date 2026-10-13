import { EstadoSurtido, Prisma } from '@prisma/client';
import { aplicarCambiosFisicos } from './aplicar-cambios-surtido.util';

/**
 * F19 (oct 2026): el invariante que sostiene toda la lectura de cantidades.
 *
 * `aplicarCambiosFisicos` SOBRESCRIBE `ItemPedido.cantidad` con lo surtido — un
 * pedido de 20 del que bodega encontró 10 queda con `cantidad: 10`. Eso es
 * correcto para el dinero (es lo que se cobra y lo que viaja al ERP), pero
 * significa que `cantidad` deja de servir para decir "lo que pediste".
 *
 * `cantidadPedida` es la columna que conserva esa referencia. Si algún camino
 * futuro la mutara, las cinco consolas volverían a mostrar un pedido incompleto
 * como si estuviera completo — el bug que estos tests fijan.
 */
function fakeTx(items: Array<Record<string, unknown>>) {
  const store = new Map<number, Record<string, unknown>>(
    items.map((i) => [i.id as number, { ...i }]),
  );
  return {
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
    },
  } as never;
}

const pedido = {
  id: 1,
  tiendaId: 1,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

describe('aplicarCambiosFisicos — cantidadPedida sobrevive al surtido', () => {
  it('un PARCIAL colapsa `cantidad` a lo surtido pero NO toca `cantidadPedida`', async () => {
    const tx = fakeTx([
      {
        id: 1,
        cantidad: 20,
        cantidadPedida: 20,
        cantidadSurtida: 10,
        estadoSurtido: EstadoSurtido.PARCIAL,
        cancelada: false,
        precioUnitario: new Prisma.Decimal(100),
      },
    ]);

    await aplicarCambiosFisicos(tx, pedido, [
      {
        id: 1,
        estadoSurtido: EstadoSurtido.PARCIAL,
        cantidadSurtida: 10,
        motivoSurtido: null,
      },
    ]);

    const item = await (tx as never as {
      itemPedido: { findUnique: (a: unknown) => Promise<Record<string, unknown>> };
    }).itemPedido.findUnique({ where: { id: 1 } });

    // `cantidad` es la VIGENTE: lo que se cobra.
    expect(item.cantidad).toBe(10);
    expect(item.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    // `cantidadPedida` es la REFERENCIA: lo que el cliente pidió. Es de donde
    // sale el "Solicitados 20 · Disponibles 10" de las cinco consolas.
    expect(item.cantidadPedida).toBe(20);
  });

  it('un NO_DISPONIBLE cancela el item y tampoco toca `cantidadPedida`', async () => {
    const tx = fakeTx([
      {
        id: 1,
        cantidad: 20,
        cantidadPedida: 20,
        cantidadSurtida: 0,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
        cancelada: false,
        precioUnitario: new Prisma.Decimal(100),
      },
    ]);

    await aplicarCambiosFisicos(tx, pedido, [
      {
        id: 1,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
        cantidadSurtida: 0,
        motivoSurtido: 'No hay',
      },
    ]);

    const item = await (tx as never as {
      itemPedido: { findUnique: (a: unknown) => Promise<Record<string, unknown>> };
    }).itemPedido.findUnique({ where: { id: 1 } });

    expect(item.cancelada).toBe(true);
    expect(item.cantidadSurtida).toBe(0);
    expect(item.cantidadPedida).toBe(20);
  });
});
