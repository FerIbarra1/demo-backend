import { EstadoPedido } from '@prisma/client';
import { VentasService } from './ventas.service';

/**
 * Oct 2026: la cola de ventas prioriza los pedidos cuyo cliente YA ESTÁ EN
 * TIENDA, y expone `esperandoDesdeMin` para que la consola lo muestre.
 *
 * El bug que estos tests previenen: el cliente llega sin ticket y sin folio, el
 * de mostrador registra su llegada, y su pedido está en la cola de ventas
 * (pidió un asesor, o hay una propuesta esperando respuesta). El asesor seguía
 * esperando a que el cliente respondiera por la app mientras lo tenía esperando
 * de pie enfrente. Es el mismo hueco que ya se cerró en la cola de bodega.
 */

function crearServicio() {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);

  const prisma = {
    pedido: { findMany, count },
  };

  const svc = new VentasService(
    prisma as never,
    {} as never, // storage
    // Oct 2026: PedidoStateService, para `devolverABodega`. Este spec solo
    // ejercita la cola (lectura), así que no se usa.
    { cambiarEstado: jest.fn() } as never,
  );

  return { svc, findMany };
}

describe('obtenerCola (ventas) — el cliente presente va primero', () => {
  it('ordena por presencia antes que por el orden propio de la cola', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5);

    const orderBy = findMany.mock.calls[0][0].orderBy;
    // La presencia del cliente es la PRIMERA clave: si el orden propio de la
    // cola mandara, un pedido con el cliente esperando de pie podría quedar
    // detrás de diez que siguen en su casa.
    expect(orderBy[0]).toEqual({
      llegadaDescartadaAt: { sort: 'asc', nulls: 'first' },
    });
    expect(orderBy[1]).toEqual({
      llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' },
    });
  });

  it('un aviso DESCARTADO no prioriza el pedido', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5);

    // `llegadaDescartadaAt` es la primera clave con `nulls: 'first'`. Sin esto,
    // un pedido cuyo aviso se desmintió (el cliente no estaba) seguiría viajando
    // al frente para siempre, porque `llegadaAnunciadaAt` no se limpia nunca.
    const primera = findMany.mock.calls[0][0].orderBy[0];
    expect(primera.llegadaDescartadaAt.nulls).toBe('first');
  });

  it('conserva el orden propio de cada filtro como última clave', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerCola(5, 1, 20, 'esperando');

    // El cambio no debe romper la razón por la que la cola ya ordenaba así:
    // en 'esperando' el pedido lleva ahí desde que se envió la propuesta.
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'desc' });
  });

  it('anota esperandoDesdeMin para el badge "Llegó a tienda"', async () => {
    const { svc, findMany } = crearServicio();
    const hace7min = new Date(Date.now() - 7 * 60_000);
    findMany.mockResolvedValue([
      {
        id: 1,
        total: 100,
        asesorSolicitadoAt: new Date(),
        estado: EstadoPedido.EN_ASESORIA,
        llegadaAnunciadaAt: hace7min,
        llegadaDescartadaAt: null,
      },
      {
        id: 2,
        total: 100,
        asesorSolicitadoAt: new Date(),
        estado: EstadoPedido.EN_ASESORIA,
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: null,
      },
    ]);

    const r = await svc.obtenerCola(5);

    // Sin este campo el vendedor no distingue al cliente que está esperando de
    // pie del que sigue en su casa — que es justo lo que el badge comunica.
    expect(r.data[0].esperandoDesdeMin).toBeGreaterThanOrEqual(6);
    expect(r.data[1].esperandoDesdeMin).toBeNull();
  });

  it('un aviso descartado no cuenta como espera', async () => {
    const { svc, findMany } = crearServicio();
    findMany.mockResolvedValue([
      {
        id: 1,
        total: 100,
        asesorSolicitadoAt: new Date(),
        estado: EstadoPedido.EN_ASESORIA,
        llegadaAnunciadaAt: new Date(Date.now() - 7 * 60_000),
        llegadaDescartadaAt: new Date(),
      },
    ]);

    const r = await svc.obtenerCola(5);
    expect(r.data[0].esperandoDesdeMin).toBeNull();
  });
});
