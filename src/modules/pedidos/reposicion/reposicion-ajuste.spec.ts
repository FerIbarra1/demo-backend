import { ReposicionService } from './reposicion.service';

/**
 * F17 (oct 2026): reposición de lo que un AJUSTE retiró del pedido.
 *
 * El bug que estos tests previenen: cuando el cliente pedía cambios y el
 * ajuste quitaba prendas, el pedido seguía vivo — pero las prendas que bodega
 * había apartado se quedaban sin que nadie las devolviera al anaquel. El único
 * camino que creaba reposición era la CANCELACIÓN (`crearDesdePedido`), y su
 * snapshot es de TODOS los items activos, que para un ajuste es lo contrario
 * de lo que hace falta.
 *
 * La diferencia clave: aquí el snapshot es SOLO de los items retirados, y la
 * cantidad a reponer es `cantidadSurtida` (lo que de verdad estaba en la
 * bolsa), no `cantidad` (lo que el cliente había pedido).
 */

function crearServicio(opts: {
  retirados?: any[];
  existente?: { id: number; items: any[] } | null;
}) {
  const create = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});

  const tx = {
    itemPedido: {
      findMany: jest.fn().mockResolvedValue(opts.retirados ?? []),
    },
    pedidoReposicion: {
      findUnique: jest.fn().mockResolvedValue(opts.existente ?? null),
      create,
      update,
    },
  };

  const svc = new ReposicionService({} as never, { emitToTienda: jest.fn() } as never);

  return { svc, tx, create, update };
}

function itemRetirado(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    productoNombre: 'Camiseta',
    productoCodigo: 'CAM-001',
    corridaNombre: 'Normal',
    tallaNombre: 'M',
    colorNombre: 'Negro',
    cantidad: 5,
    cantidadSurtida: 2,
    estadoSurtido: 'NO_DISPONIBLE',
    ...over,
  };
}

describe('ReposicionService.crearDesdeAjuste', () => {
  it('sin items retirados no crea nada', async () => {
    const { svc, tx, create } = crearServicio({ retirados: [] });
    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');
    expect(create).not.toHaveBeenCalled();
  });

  it('solo snapshotea los items CANCELADOS', async () => {
    const { svc, tx } = crearServicio({ retirados: [itemRetirado()] });
    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');

    const where = tx.itemPedido.findMany.mock.calls[0][0].where;
    // El filtro de cantidad NO puede vivir en el WHERE: el ajuste pone
    // `cantidadSurtida: 0` al cancelar, así que filtrar por `> 0` aquí
    // devolvería vacío (el bug que encontró la prueba end-to-end). El filtro de
    // "hay algo que reponer" se hace en memoria, con las piezas capturadas
    // antes del ajuste.
    expect(where).toEqual({ pedidoId: 1, cancelada: true });
  });

  it('usa las piezas capturadas ANTES del ajuste, no el cantidadSurtida borrado', async () => {
    // El caso real: el ajuste cancela el item y le pone `cantidadSurtida: 0`.
    // Sin el mapa de piezas capturadas, la lista saldría vacía y la mercancía
    // se quedaría sin devolver al anaquel.
    const { svc, tx, create } = crearServicio({
      retirados: [itemRetirado({ id: 7, cantidad: 3, cantidadSurtida: 0 })],
    });

    await svc.crearDesdeAjuste(
      tx as never,
      1,
      'Ajuste',
      new Map([[7, 3]]),
    );

    const items = create.mock.calls[0][0].data.items;
    expect(items).toHaveLength(1);
    expect(items[0].cantidad).toBe(3);
  });

  it('descarta los items sin piezas que reponer', async () => {
    // Un item cancelado del que nunca se apartó nada no genera trabajo.
    const { svc, tx, create } = crearServicio({
      retirados: [itemRetirado({ id: 8, cantidad: 5, cantidadSurtida: 0 })],
    });

    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste', new Map());
    expect(create).not.toHaveBeenCalled();
  });

  it('repone la cantidad SURTIDA, no la pedida', async () => {
    // Bodega había surtido 2 de 5, y el ajuste canceló el item. En la bolsa
    // hay 2 prendas: reponer 5 mandaría a buscar prendas que nunca salieron.
    const { svc, tx, create } = crearServicio({
      retirados: [itemRetirado({ cantidad: 5, cantidadSurtida: 2 })],
    });
    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');

    const items = create.mock.calls[0][0].data.items;
    expect(items[0].cantidad).toBe(2);
  });

  it('crea la lista en PENDIENTE con el motivo del ajuste', async () => {
    const { svc, tx, create } = crearServicio({ retirados: [itemRetirado()] });
    await svc.crearDesdeAjuste(tx as never, 1, 'El cliente cambió de talla');

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pedidoId: 1,
        estado: 'PENDIENTE',
        motivo: 'El cliente cambió de talla',
      }),
    });
  });

  it('agrega los retiros nuevos a una lista existente sin duplicar', async () => {
    // El pedido puede acumular retiros de varios ajustes. Los que ya estaban
    // en la lista no se vuelven a agregar.
    const { svc, tx, update, create } = crearServicio({
      retirados: [itemRetirado({ id: 1 }), itemRetirado({ id: 2 })],
      existente: { id: 10, items: [{ id: 1, cantidad: 2 }] },
    });

    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');

    expect(create).not.toHaveBeenCalled();
    const items = update.mock.calls[0][0].data.items;
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.id)).toEqual([1, 2]);
  });

  it('si no hay retiros nuevos, no toca la lista existente', async () => {
    const { svc, tx, update } = crearServicio({
      retirados: [itemRetirado({ id: 1 })],
      existente: { id: 10, items: [{ id: 1, cantidad: 2 }] },
    });

    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');
    expect(update).not.toHaveBeenCalled();
  });

  it('REABRE una lista ya repuesta: hay mercancía nueva que acomodar', async () => {
    // Si bodega ya había confirmado el repuesto y un ajuste posterior retira
    // más prendas, la lista tiene que volver a PENDIENTE — si no, la mercancía
    // nueva se quedaría sin nadie que la devuelva.
    const { svc, tx, update } = crearServicio({
      retirados: [itemRetirado({ id: 3 })],
      existente: { id: 10, items: [{ id: 1, cantidad: 2 }] },
    });

    await svc.crearDesdeAjuste(tx as never, 1, 'Ajuste');

    expect(update.mock.calls[0][0].data).toMatchObject({
      estado: 'PENDIENTE',
      repuestoAt: null,
      repuestoPorId: null,
    });
  });
});
