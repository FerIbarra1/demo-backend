import { EstadoPedido } from '@prisma/client';
import { MostradorQueryService } from './mostrador-query.service';

/**
 * F22 (oct 2026): la cola ("Por revisar"), la lista "Sin aviso" y la de entrega.
 *
 *  - La cola usa la regla ÚNICA de presencia y "primero llegado, primero atendido".
 *  - "Sin aviso" ahora incluye lo que esperaba aprobación y los kioskos descartados,
 *    y cada fila lleva su antigüedad y si está VENCIDA.
 */

const horas = (h: number) => new Date(Date.now() - h * 3_600_000);
const config = {
  get: () => ({ recordatorioHoras: 24, vencidoHoras: 72, presenciaCaducaHoras: 8 }),
};

function fila(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    canalOrigen: 'WEB',
    estado: EstadoPedido.REVISADO,
    fechaPedido: horas(5),
    llegadaAnunciadaAt: null,
    llegadaDescartadaAt: null,
    presenteDesdeAt: null,
    esperaClienteDesdeAt: null,
    recordatorioRecogerAt: null,
    llamadoPor: null,
    llamadoMostrador: null,
    items: [],
    ...extra,
  };
}

function crearServicio(filas: Array<Record<string, unknown>> = [], total = filas.length) {
  const findMany = jest.fn().mockResolvedValue(filas);
  const count = jest.fn().mockResolvedValue(total);
  const svc = new MostradorQueryService(
    // `pedidoDtf`: las filas ahora llevan su resumen de DTF; estos pedidos no tienen ninguno.
    {
      pedido: { findMany, count },
      pedidoDtf: { findMany: jest.fn().mockResolvedValue([]) },
    } as never,
    {} as never,
    config as never,
  );
  return { svc, findMany, count };
}

describe('obtenerCola', () => {
  it('muestra REVISADO y EN_ATENCION de clientes presentes', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5);

    const where = findMany.mock.calls[0][0].where;
    expect(where.tiendaId).toBe(5);
    expect(where.estado).toEqual({ in: [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION] });
    expect(where.llegadaDescartadaAt).toBeNull();
    expect(where.OR).toEqual([
      { canalOrigen: 'KIOSKO' },
      { canalOrigen: 'WEB', llegadaAnunciadaAt: { not: null } },
    ]);
  });

  it('ordena por presenteDesdeAt (primero llegado, primero atendido)', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5);
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({
      presenteDesdeAt: { sort: 'asc', nulls: 'last' },
    });
  });

  it('un pedido de KIOSKO lleva su espera real y cuenta como cliente en tienda', async () => {
    const { svc } = crearServicio([
      fila({ canalOrigen: 'KIOSKO', presenteDesdeAt: horas(0.5), fechaPedido: horas(0.5) }),
    ]);

    const r = await svc.obtenerCola(5);

    expect(r.data[0].clienteEnTienda).toBe(true);
    expect(r.data[0].esperandoDesdeMin).toBe(30);
  });

  it('un pedido ya llamado dice QUIÉN lo atiende y en qué mostrador', async () => {
    // El segundo operador que abre un pedido ya llamado ve "Lo atiende Ana ·
    // Mostrador 2" y no pisa a su compañera.
    const { svc } = crearServicio([
      fila({
        estado: EstadoPedido.EN_ATENCION,
        llegadaAnunciadaAt: horas(1),
        presenteDesdeAt: horas(1),
        llamadoPor: { id: 3, nombre: 'Ana', apellido: 'Ruiz' },
        llamadoMostrador: { id: 8, numero: 2 },
      }),
    ]);

    const r = await svc.obtenerCola(5);

    expect(r.data[0].atendidoPorNombre).toBe('Ana Ruiz');
    expect(r.data[0].mostradorNumero).toBe(2);
  });

  it('un pedido sin llamar no trae atención', async () => {
    const { svc } = crearServicio([
      fila({ llegadaAnunciadaAt: horas(1), presenteDesdeAt: horas(1) }),
    ]);
    const r = await svc.obtenerCola(5);
    expect(r.data[0].atendidoPorNombre).toBeNull();
    expect(r.data[0].mostradorNumero).toBeNull();
  });

  it('pide a Prisma quién llamó y el mostrador', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5);
    const include = findMany.mock.calls[0][0].include;
    expect(include.llamadoPor).toBeDefined();
    expect(include.llamadoMostrador).toBeDefined();
  });
});

describe('obtenerSinAviso — la bolsa apartada sin cliente', () => {
  it('incluye ESPERANDO_APROBACION además de REVISADO', async () => {
    // El cliente que no contestó su propuesta tiene la bolsa apartada igual que uno
    // de REVISADO, y es el que más tiempo lleva sin aparecer.
    const { svc, findMany } = crearServicio();
    await svc.obtenerSinAviso(5);

    expect(findMany.mock.calls[0][0].where.estado).toEqual({
      in: [EstadoPedido.REVISADO, EstadoPedido.ESPERANDO_APROBACION],
    });
  });

  it('incluye los de kiosko cuyo cliente se fue (descartados), no solo los web', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerSinAviso(5);

    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([{ llegadaDescartadaAt: { not: null } }]));
    // Y NO restringe al canal WEB a nivel raíz.
    expect(where.canalOrigen).toBeUndefined();
  });

  it('ordena los más viejos primero (los que más tiempo llevan atorados)', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerSinAviso(5);
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({
      esperaClienteDesdeAt: { sort: 'asc', nulls: 'last' },
    });
  });

  it('marca VENCIDO a lo que pasó las 72 h, y recordable a lo que pasó las 24 h', async () => {
    const { svc } = crearServicio([
      fila({ id: 1, esperaClienteDesdeAt: horas(80) }),
      fila({ id: 2, esperaClienteDesdeAt: horas(30), recordatorioRecogerAt: horas(6) }),
      fila({ id: 3, esperaClienteDesdeAt: horas(2) }),
    ]);

    const r = await svc.obtenerSinAviso(5);

    expect(r.data.map((p) => p.vencido)).toEqual([true, false, false]);
    expect(r.data.map((p) => p.recordatorioEnviado)).toEqual([false, true, false]);
    expect(r.data[0].horasEsperando).toBe(80);
    expect(r.data[2].horasEsperando).toBe(2);
  });

  it('un pedido sin marca de espera no es vencido ni inventa horas', async () => {
    const { svc } = crearServicio([fila({ esperaClienteDesdeAt: null })]);
    const r = await svc.obtenerSinAviso(5);
    expect(r.data[0].vencido).toBe(false);
    expect(r.data[0].horasEsperando).toBeNull();
  });

  it("con filtro 'vencidos' solo pide los que pasaron el plazo", async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerSinAviso(5, 1, 20, 'vencidos');

    const limite = (findMany.mock.calls[0][0].where.esperaClienteDesdeAt.lt as Date).getTime();
    expect(Math.abs(Date.now() - 72 * 3_600_000 - limite)).toBeLessThan(5_000);
  });

  it("con filtro 'todos' no recorta por antigüedad", async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerSinAviso(5, 1, 20, 'todos');
    expect(findMany.mock.calls[0][0].where.esperaClienteDesdeAt).toBeUndefined();
  });

  it('el total de vencidos va aparte del de la lista, para el chip y la pestaña', async () => {
    const { svc, count } = crearServicio([], 12);
    count.mockResolvedValueOnce(12).mockResolvedValueOnce(4);

    const r = await svc.obtenerSinAviso(5);

    expect(r.meta.total).toBe(12);
    expect(r.meta.vencidos).toBe(4);
  });

  it('expone los plazos para que la pantalla diga "vence a las 72 h" sin duplicar el número', async () => {
    const { svc } = crearServicio();
    const r = await svc.obtenerSinAviso(5);
    expect(r.meta.vencidoHoras).toBe(72);
    expect(r.meta.recordatorioHoras).toBe(24);
  });

  // Oct 2026 (F0 del plan ADMIN multitienda): "Sin aviso" era la única lista de mostrador sin
  // `dtfResumen`. Un pedido solo-DTF apartado se pintaba como "0 producto(s)" y mostrador no
  // sabía que la bolsa incluía una impresión (ni si ya estaba lista).
  it('cada fila lleva su resumen de DTF (null si el pedido no tiene)', async () => {
    const pedidoDtf = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 11,
          pedidoId: 1,
          nombre: 'LOGO',
          estado: 'IMPRESO',
          copias: 1,
          metrosCobrados: 0.5,
          precioMetro: 220,
          subtotal: 110,
          tipo: { tecnologia: 'TEXTIL', nombre: 'DTF Textil' },
        },
      ]),
    };
    const svc = new MostradorQueryService(
      {
        pedido: {
          findMany: jest.fn().mockResolvedValue([fila({ id: 1 }), fila({ id: 2 })]),
          count: jest.fn().mockResolvedValue(2),
        },
        pedidoDtf,
      } as never,
      {} as never,
      config as never,
    );

    const r = await svc.obtenerSinAviso(5);

    expect(r.data[0].dtfResumen).toMatchObject({
      total: 110,
      cobrados: 1,
      listos: 1,
      pendientes: 0,
    });
    expect(r.data[1].dtfResumen).toBeNull();
    // Una sola consulta para toda la lista, no una por pedido.
    expect(pedidoDtf.findMany).toHaveBeenCalledTimes(1);
    expect(pedidoDtf.findMany.mock.calls[0][0].where.pedidoId).toEqual({ in: [1, 2] });
  });
});

describe('obtenerPedidosListos — un aviso descartado no cuela al pedido al frente', () => {
  it('ordena los descartados al final', async () => {
    // `presenteDesdeAt` queda seteado tras un descarte; sin esta clave el pedido de un
    // cliente que ya se fue viajaría prioritario por un aviso que se desmintió.
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosListos(5, 1, 20, 'esperando');

    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ llegadaDescartadaAt: { sort: 'asc', nulls: 'first' } });
    expect(orderBy[1]).toEqual({ presenteDesdeAt: { sort: 'asc', nulls: 'last' } });
  });

  it("con orden 'pago' ordena solo por fecha de pago", async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosListos(5, 1, 20, 'pago');
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({ fechaPago: 'asc' });
  });
});
