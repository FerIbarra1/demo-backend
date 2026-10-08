import { EstadoPedido } from '@prisma/client';
import { BodegaService } from './bodega.service';

/**
 * F17 (oct 2026): el endpoint de la PLANCHA.
 *
 * El problema que resuelve: cuando el cliente pide cambios en mostrador, el
 * pedido vuelve a bodega — pero la bolsa con el ticket SIGUE físicamente en la
 * mesa de la plancha. En la tablet de surtido ese pedido aparecía como una
 * tarjeta más en la cola, indistinguible de un pedido nuevo, y el bodeguero no
 * sabía que tenía que ir a la plancha a sacar prendas de una bolsa ni cuáles
 * traer del anaquel.
 *
 * Estos tests fijan las dos mitades del contrato:
 *   1. Solo aparecen los pedidos que NECESITAN ajuste (nada de ruido).
 *   2. Cada uno trae qué quitar de la bolsa y qué traer del anaquel.
 */

function crearServicio(pedidos: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(pedidos);

  const prisma = {
    pedido: { findMany },
  };

  const svc = new BodegaService(
    prisma as never,
    {} as never, // realtime
    {} as never, // state
    {} as never, // access
  );

  return { svc, findMany };
}

/** Un pedido tal como lo devuelve la query del endpoint. */
function pedido(opts: {
  id?: number;
  items?: any[];
  estadoAnterior?: EstadoPedido | null;
}) {
  return {
    id: opts.id ?? 1,
    numeroPedido: 'PD-2026-000123',
    clienteNombre: 'Juan Pérez',
    canalOrigen: 'KIOSCO',
    fechaPedido: new Date('2026-10-05T10:00:00Z'),
    items: opts.items ?? [],
    historial: [{ estadoAnterior: opts.estadoAnterior ?? EstadoPedido.REVISADO }],
  };
}

/** Un item del pedido, con los defaults que no importan para el test. */
function item(over: Record<string, unknown>) {
  return {
    id: 1,
    productoCodigo: 'CAM-001',
    productoNombre: 'Camiseta',
    corridaNombre: 'Normal',
    tallaNombre: 'M',
    colorNombre: 'Negro',
    cantidad: 3,
    cantidadSurtida: 3,
    original: true,
    cancelada: false,
    ...over,
  };
}

describe('obtenerAjustesPlancha', () => {
  it('sin tienda devuelve vacío (no consulta)', async () => {
    const { svc, findMany } = crearServicio();
    await expect(svc.obtenerAjustesPlancha(undefined)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('solo busca pedidos EN_REVISION sin asignar', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerAjustesPlancha(5);

    const where = findMany.mock.calls[0][0].where;
    expect(where.estado).toBe(EstadoPedido.EN_REVISION);
    // Sin asignar: si ya lo tomó un bodeguero, está en su slot, no en el aviso.
    expect(where.asignadoAId).toBeNull();
    expect(where.tiendaId).toBe(5);
  });

  it('filtra a los que traen items nuevos o retirados (nada de ruido)', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerAjustesPlancha(5);

    // El predicado es lo que evita que un pedido liberado (sin cambios)
    // aparezca en la tarjeta: `original: false` es la señal de "vino con
    // cambios", que ya usa el monitor de bodega.
    const where = findMany.mock.calls[0][0].where;
    expect(where.items).toEqual({
      some: { OR: [{ original: false }, { cancelada: true }] },
    });
  });

  it('separa lo que se QUITA de la bolsa de lo que se TRAE del anaquel', async () => {
    const { svc } = crearServicio([
      pedido({
        items: [
          // Quedó igual: no aparece en ninguna lista.
          item({ id: 1 }),
          // El ajuste lo canceló → hay que sacarlo de la bolsa.
          item({
            id: 2,
            productoCodigo: 'CAM-002',
            tallaNombre: 'L',
            cantidad: 2,
            cantidadSurtida: 2,
            cancelada: true,
          }),
          // El ajuste lo agregó → hay que traerlo del anaquel.
          item({
            id: 3,
            productoCodigo: 'CAM-003',
            tallaNombre: 'S',
            cantidad: 4,
            cantidadSurtida: 0,
            original: false,
          }),
        ],
      }),
    ]);

    const [r] = await svc.obtenerAjustesPlancha(5);

    expect(r.porQuitar).toHaveLength(1);
    expect(r.porQuitar[0]).toMatchObject({
      itemId: 2,
      productoCodigo: 'CAM-002',
      tallaNombre: 'L',
      cantidad: 2,
    });

    expect(r.porAgregar).toHaveLength(1);
    expect(r.porAgregar[0]).toMatchObject({
      itemId: 3,
      productoCodigo: 'CAM-003',
      tallaNombre: 'S',
      cantidad: 4,
    });

    expect(r.piezasPorQuitar).toBe(2);
    expect(r.piezasPorAgregar).toBe(4);
  });

  it('usa la cantidad REALMENTE apartada cuando bodega surtió de menos', async () => {
    // Si el bodeguero había surtido 2 de 5 y el ajuste cancela el item, en la
    // bolsa hay 2 prendas, no 5. Decirle "quita 5" lo mandaría a buscar
    // prendas que nunca estuvieron ahí.
    const { svc } = crearServicio([
      pedido({
        items: [
          item({ id: 2, cantidad: 5, cantidadSurtida: 2, cancelada: true }),
        ],
      }),
    ]);

    const [r] = await svc.obtenerAjustesPlancha(5);
    expect(r.porQuitar[0].cantidad).toBe(2);
    expect(r.piezasPorQuitar).toBe(2);
  });

  it('un item cancelado NO se cuenta también como agregado', async () => {
    // Un item cancelado que además fuera `original: false` (agregado en un
    // ajuste anterior y luego retirado) debe aparecer SOLO en `porQuitar`.
    // Si apareciera en las dos listas, el bodeguero lo sacaría y lo traería.
    const { svc } = crearServicio([
      pedido({
        items: [item({ id: 9, original: false, cancelada: true })],
      }),
    ]);

    const [r] = await svc.obtenerAjustesPlancha(5);
    expect(r.porQuitar).toHaveLength(1);
    expect(r.porAgregar).toHaveLength(0);
  });

  it('deriva el motivo de reingreso del último cambio de estado', async () => {
    const { svc } = crearServicio([
      pedido({ id: 1, estadoAnterior: EstadoPedido.REVISADO, items: [item({ cancelada: true })] }),
      pedido({
        id: 2,
        estadoAnterior: EstadoPedido.ESPERANDO_APROBACION,
        items: [item({ id: 5, original: false })],
      }),
    ]);

    const r = await svc.obtenerAjustesPlancha(5);
    // Vino de la plancha → el cliente cambió algo en mostrador.
    expect(r[0].motivoReingreso).toBe('AJUSTE_MOSTRADOR');
    // Vino de una propuesta → el cliente aprobó la contrapropuesta del asesor.
    expect(r[1].motivoReingreso).toBe('PROPUESTA_VENTAS');
  });
});
