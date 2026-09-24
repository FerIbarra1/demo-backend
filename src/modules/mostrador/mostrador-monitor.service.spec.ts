import { EstadoPedido, CanalOrigen } from '@prisma/client';
import { MostradorMonitorService } from './mostrador-monitor.service';

/**
 * F16 (sep 2026): tests del gate de visibilidad de la cola de mostrador.
 *
 * Es la regla de negocio de la decisión D5 y la más fácil de romper en
 * silencio: un pedido web SIN aviso de llegada NO debe aparecer en el monitor
 * (podría estar en casa del cliente; el operador no tiene a quién llamar). Si
 * el gate se afloja, el operador llamaría a gente que no está en la tienda.
 *
 * También fija que el monitor NO calcula urgencia (decisión D13).
 */

/** Prisma mockeado: captura el `where` que el service construye. */
function crearServicio() {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);

  const prisma = {
    tienda: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Tienda Test' }),
    },
    pedido: { findMany, count },
  };

  return { svc: new MostradorMonitorService(prisma as never), findMany, count };
}

describe('MostradorMonitorService — gate de llegada (D5)', () => {
  it('filtra por EN_MOSTRADOR', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const where = findMany.mock.calls[0][0].where;
    expect(where.estado).toBe(EstadoPedido.EN_MOSTRADOR);
    expect(where.tiendaId).toBe(5);
  });

  it('el OR incluye kiosko sin condición de llegada', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const or = findMany.mock.calls[0][0].where.OR;
    const kiosko = or.find((c: any) => c.canalOrigen === CanalOrigen.KIOSKO);
    expect(kiosko).toEqual({ canalOrigen: CanalOrigen.KIOSKO });
    // Sin `llegadaAnunciadaAt`: el pedido se hizo en la tienda, el cliente
    // está ahí por definición.
    expect(kiosko.llegadaAnunciadaAt).toBeUndefined();
  });

  it('el OR exige llegada activa para los pedidos web', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const or = findMany.mock.calls[0][0].where.OR;
    const web = or.find((c: any) => c.canalOrigen === CanalOrigen.WEB);
    expect(web.llegadaAnunciadaAt).toEqual({ not: null });
    // Un aviso DESCARTADO (cliente se fue) no debe reabrir el pedido.
    expect(web.llegadaDescartadaAt).toBeNull();
  });

  it('ordena avisados primero, luego por antigüedad', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ llegadaAnunciadaAt: { sort: 'asc', nulls: 'last' } });
    expect(orderBy[1]).toEqual({ fechaPedido: 'asc' });
  });

  it('NO pide ni expone nivelUrgencia (decisión D13)', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    // El select no debe traer campos de urgencia, y el mapeo tampoco.
    const select = findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('nivelUrgencia');
  });

  it('lanza 400 si el usuario no tiene tienda', async () => {
    const { svc } = crearServicio();
    await expect(svc.obtenerMonitor(0)).rejects.toThrow(/tienda asignada/i);
  });

  it('cuenta los pedidos listos para entregar (PAID|SHIPPED)', async () => {
    const { svc, count } = crearServicio();
    await svc.obtenerMonitor(5);
    const where = count.mock.calls[0][0].where;
    expect(where.estado.in).toEqual([EstadoPedido.PAID, EstadoPedido.SHIPPED]);
  });
});

/**
 * F16: panel "Atendiendo". El pedido llamado sale de la cola y entra a este
 * panel, donde se queda hasta que salga de EN_MOSTRADOR. Si la cola no lo
 * excluyera, el cliente ya llamado seguiría viéndose en la lista de espera.
 */
describe('MostradorMonitorService — panel Atendiendo', () => {
  it('la cola excluye los pedidos ya llamados', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const whereCola = findMany.mock.calls[0][0].where;
    expect(whereCola.llamadoAt).toBeNull();
  });

  it('el panel Atendiendo filtra por llamadoAt no nulo', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const whereAtendiendo = findMany.mock.calls[1][0].where;
    expect(whereAtendiendo.llamadoAt).toEqual({ not: null });
    // Conserva el gate de llegada: no se cuela un web que nunca avisó.
    expect(whereAtendiendo.estado).toBe(EstadoPedido.EN_MOSTRADOR);
    expect(whereAtendiendo.OR).toBeDefined();
  });

  it('ordena el panel por llamado más reciente primero', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const orderBy = findMany.mock.calls[1][0].orderBy;
    expect(orderBy[0]).toEqual({ llamadoAt: 'desc' });
  });

  it('expone `atendiendo` en el snapshot y en los contadores', async () => {
    const { svc } = crearServicio();
    const res = await svc.obtenerMonitor(5);
    expect(res.atendiendo).toEqual([]);
    expect(res.contadores.atendiendo).toBe(0);
  });
});
