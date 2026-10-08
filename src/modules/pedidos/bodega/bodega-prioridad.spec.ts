import { EstadoPedido } from '@prisma/client';
import { BodegaService } from './bodega.service';

/**
 * Oct 2026: la cola de bodega prioriza los pedidos cuyo cliente YA ESTÁ EN
 * TIENDA.
 *
 * El bug que estos tests previenen: el cliente llega a tienda sin ticket y sin
 * folio, el de mostrador registra su llegada, y su pedido sigue en bodega. Si la
 * cola de bodega no cambia de orden, el aviso queda de adorno — el bodeguero
 * sigue surtiendo por FIFO y el cliente espera de pie sin que nadie sepa por
 * qué. La decisión de negocio fue explícita: registrar la llegada Y priorizar.
 */

function crearServicio() {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);

  const prisma = {
    pedido: { findMany, count },
  };

  const svc = new BodegaService(
    prisma as never,
    {} as never, // realtime
    {} as never, // state
    {} as never, // access
  );

  return { svc, findMany };
}

describe('obtenerPedidosBodega — el cliente presente va primero', () => {
  it('ordena por llegada antes que por antigüedad', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosBodega(5);

    const orderBy = findMany.mock.calls[0][0].orderBy;
    // La primera clave es la presencia del cliente, no `fechaPedido`: si el
    // FIFO mandara, un pedido con el cliente esperando de pie podría quedar
    // detrás de diez que nadie vino a recoger.
    expect(orderBy[0]).toEqual({
      llegadaDescartadaAt: { sort: 'asc', nulls: 'first' },
    });
    expect(orderBy[1]).toEqual({
      llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' },
    });
    expect(orderBy[2]).toEqual({ fechaPedido: 'asc' });
  });

  it('un aviso DESCARTADO no prioriza el pedido', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosBodega(5);

    // `llegadaDescartadaAt` es la primera clave y con `nulls: 'first'`: los
    // pedidos sin descarte van antes que los descartados. Sin esto, un pedido
    // cuyo aviso se desmintió (el cliente no estaba) seguiría viajando al frente
    // de la cola para siempre, porque `llegadaAnunciadaAt` no se limpia nunca.
    const primera = findMany.mock.calls[0][0].orderBy[0];
    expect(primera.llegadaDescartadaAt.nulls).toBe('first');
  });

  it('el FIFO se conserva dentro de cada grupo', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosBodega(5);

    // La última clave sigue siendo `fechaPedido asc`: entre dos pedidos con
    // cliente presente, atiende primero al que llegó antes.
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[orderBy.length - 1]).toEqual({ fechaPedido: 'asc' });
  });

  it('sigue filtrando por los estados de la cola de bodega', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerPedidosBodega(5);

    // El cambio de orden no debe tocar el `where`: la cola sigue siendo
    // SOLICITADO + EN_REVISION.
    expect(findMany.mock.calls[0][0].where.estado).toEqual({
      in: [EstadoPedido.SOLICITADO, EstadoPedido.EN_REVISION],
    });
  });
});

describe('obtenerMisPedidosBodeguero — el orden NO cambia', () => {
  it('mantiene el orden por asignación', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMisPedidosBodeguero(3, 5);

    // Los pedidos que el bodeguero YA TOMÓ se trabajan en el orden en que los
    // tomó. Reordenarlos por presencia movería el trabajo de sus manos a media
    // tarea — es una cola distinta, con otro dueño.
    expect(findMany.mock.calls[0][0].orderBy).toEqual({ asignadoAt: 'asc' });
  });
});
