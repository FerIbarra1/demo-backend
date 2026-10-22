import { conResumenDtf, resumenDtfPorPedido } from './dtf-resumen';

/** Una fila como la devuelve `pedidoDtf.findMany` con el `select` del resumen. */
const fila = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  pedidoId: 10,
  nombre: 'LOGO',
  estado: 'IMPRESO',
  copias: 1,
  metrosCobrados: '1',
  precioMetro: '220',
  subtotal: '220',
  tipo: { tecnologia: 'TEXTIL', nombre: 'DTF Textil' },
  ...o,
});

const prismaCon = (filas: unknown[]) =>
  ({ pedidoDtf: { findMany: jest.fn().mockResolvedValue(filas) } }) as never;

describe('resumenDtfPorPedido (lo que ven mostrador y caja del DTF)', () => {
  it('sin pedidos no consulta nada', async () => {
    const prisma = prismaCon([]);
    expect((await resumenDtfPorPedido(prisma, [])).size).toBe(0);
    expect(
      (prisma as never as { pedidoDtf: { findMany: jest.Mock } }).pedidoDtf.findMany,
    ).not.toHaveBeenCalled();
  });

  it('cuenta listos y pendientes, y suma solo lo que se cobra', async () => {
    const prisma = prismaCon([
      fila({ id: 1, estado: 'IMPRESO' }),
      fila({
        id: 2,
        estado: 'EN_IMPRESION',
        metrosCobrados: '0.5',
        subtotal: '110',
        nombre: 'TAMALES',
      }),
      fila({ id: 3, estado: 'RECHAZADO', subtotal: '220', nombre: 'MALO' }),
    ]);
    const r = (await resumenDtfPorPedido(prisma, [10])).get(10)!;
    expect(r.lineas).toHaveLength(3);
    expect(r.cobrados).toBe(2); // el rechazado no se cobra
    expect(r.listos).toBe(1);
    expect(r.pendientes).toBe(1);
    expect(r.total).toBe(330);
    expect(r.lineas.find((l) => l.id === 3)?.cobra).toBe(false);
  });

  it('redacta para caja una línea por trabajo que se cobra (Caso B del ERP)', async () => {
    const prisma = prismaCon([
      fila({ estado: 'APROBADO', metrosCobrados: '0.5', subtotal: '110' }),
      fila({ id: 2, estado: 'RECHAZADO' }),
    ]);
    const r = (await resumenDtfPorPedido(prisma, [10])).get(10)!;
    expect(r.capturaCaja).toEqual(['DTF Textil · LOGO — 0.50 m × $220.00 = $110.00']);
  });

  it('un trabajo sin medir se dice "por medir" en lugar de inventar metros', async () => {
    const prisma = prismaCon([fila({ estado: 'RECIBIDO', metrosCobrados: null, subtotal: '110' })]);
    const r = (await resumenDtfPorPedido(prisma, [10])).get(10)!;
    expect(r.lineas[0].metros).toBeNull();
    expect(r.capturaCaja[0]).toContain('por medir m');
  });

  it('un pedido sin DTF no trae resumen (null), el resto sí', async () => {
    const prisma = prismaCon([fila()]);
    const filas = await conResumenDtf(prisma, [{ id: 10 }, { id: 11 }]);
    expect(filas[0].dtfResumen?.listos).toBe(1);
    expect(filas[1].dtfResumen).toBeNull();
  });

  it('hace UNA consulta para toda la lista, con los ids de la lista', async () => {
    const prisma = prismaCon([]);
    await conResumenDtf(prisma, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const findMany = (prisma as never as { pedidoDtf: { findMany: jest.Mock } }).pedidoDtf.findMany;
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.pedidoId).toEqual({ in: [1, 2, 3] });
  });
});
