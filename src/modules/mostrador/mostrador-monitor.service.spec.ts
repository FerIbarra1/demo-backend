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
  it('filtra por REVISADO', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const where = findMany.mock.calls[0][0].where;
    expect(where.estado).toBe(EstadoPedido.REVISADO);
    expect(where.tiendaId).toBe(5);
  });

  it('el OR incluye kiosko sin condición de aviso', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const or = findMany.mock.calls[0][0].where.OR;
    const kiosko = or.find((c: any) => c.canalOrigen === CanalOrigen.KIOSKO);
    expect(kiosko).toEqual({ canalOrigen: CanalOrigen.KIOSKO });
    // Sin `llegadaAnunciadaAt`: el pedido se hizo en la tienda, el cliente
    // está ahí por definición.
    expect(kiosko.llegadaAnunciadaAt).toBeUndefined();
  });

  it('el OR exige aviso para los pedidos web', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const or = findMany.mock.calls[0][0].where.OR;
    const web = or.find((c: any) => c.canalOrigen === CanalOrigen.WEB);
    expect(web.llegadaAnunciadaAt).toEqual({ not: null });
  });

  it('un aviso DESCARTADO saca al pedido de la cola, sea web O kiosko', async () => {
    // F22: antes `llegadaDescartadaAt: null` solo estaba en la rama web, así que
    // un pedido de kiosko cuyo cliente se fue no tenía forma de salir de la TV.
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const where = findMany.mock.calls[0][0].where;
    expect(where.llegadaDescartadaAt).toBeNull();
  });

  it('ordena "primero llegado, primero atendido": presenteDesdeAt, no el aviso', async () => {
    // F22: se ordenaba por `llegadaAnunciadaAt nulls last`, y un pedido de kiosko
    // no tiene aviso — TODO web con aviso pasaba delante de cualquier kiosko aunque
    // el kiosko llevara media hora esperando.
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ presenteDesdeAt: { sort: 'asc', nulls: 'last' } });
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
    expect(where.estado.in).toEqual([EstadoPedido.PAGADO, EstadoPedido.ENVIADO]);
  });
});

/**
 * F16: panel "Atendiendo". El pedido llamado sale de la cola y entra a este
 * panel, donde se queda hasta que salga de REVISADO. Si la cola no lo
 * excluyera, el cliente ya llamado seguiría viéndose en la lista de espera.
 */
describe('MostradorMonitorService — panel Atendiendo', () => {
  it('la cola es solo REVISADO (excluye a los ya llamados)', async () => {
    // F17: el discriminador es el ESTADO, no `llamadoAt`. Un pedido ya llamado
    // está en EN_ATENCION, así que la cola lo excluye por el propio estado —
    // ya no hace falta recordar un filtro extra en cada query.
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const whereCola = findMany.mock.calls[0][0].where;
    expect(whereCola.estado).toBe(EstadoPedido.REVISADO);
    expect(whereCola.llamadoAt).toBeUndefined();
  });

  it('el panel Atendiendo filtra por el estado EN_ATENCION', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    const whereAtendiendo = findMany.mock.calls[1][0].where;
    expect(whereAtendiendo.estado).toBe(EstadoPedido.EN_ATENCION);
    expect(whereAtendiendo.llamadoAt).toBeUndefined();
    // Conserva el gate de presencia: no se cuela un web que nunca avisó.
    expect(whereAtendiendo.OR).toBeDefined();
    expect(whereAtendiendo.llegadaDescartadaAt).toBeNull();
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

/**
 * F22: la TV dice A QUÉ MOSTRADOR pasar. Con varios operadores, un "pasa a
 * mostrador" a secas deja al cliente sin saber a quién acercarse.
 */
describe('MostradorMonitorService — mostrador que llama (F22)', () => {
  const fila = (extra: Record<string, unknown> = {}) => ({
    id: 1,
    numeroPedido: 'PD-2026-000001',
    clienteNombre: 'Juan',
    canalOrigen: CanalOrigen.WEB,
    total: 100,
    fechaPedido: new Date(Date.now() - 3_600_000),
    llegadaAnunciadaAt: new Date(Date.now() - 600_000),
    llegadaDescartadaAt: null,
    presenteDesdeAt: new Date(Date.now() - 600_000),
    llamadoAt: new Date(),
    llamadoMostrador: { numero: 2 },
    llamadoPor: { nombre: 'Ana', apellido: 'Ruiz' },
    _count: { items: 3 },
    ...extra,
  });

  it('el panel Atendiendo lleva el número de mostrador y el operador', async () => {
    const { svc, findMany } = crearServicio();
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION ? [fila()] : [],
    );

    const res = await svc.obtenerMonitor(5);

    expect(res.atendiendo[0].mostradorNumero).toBe(2);
    expect(res.atendiendo[0].operadorNombre).toBe('Ana Ruiz');
  });

  it('sin mostradores configurados el número es null (la TV dice solo "Pasa a mostrador")', async () => {
    const { svc, findMany } = crearServicio();
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION
        ? [fila({ llamadoMostrador: null, llamadoPor: null })]
        : [],
    );

    const res = await svc.obtenerMonitor(5);

    expect(res.atendiendo[0].mostradorNumero).toBeNull();
    expect(res.atendiendo[0].operadorNombre).toBeNull();
  });

  it('un pedido de KIOSKO en la cola cuenta como cliente en tienda, con su espera real', async () => {
    // Antes `clienteEnTienda` miraba solo el aviso, y un kiosko (que nunca lo
    // tiene) aparecía como "sin cliente" en los contadores.
    const { svc, findMany } = crearServicio();
    const hace30 = new Date(Date.now() - 30 * 60_000);
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.REVISADO && args.where.llegadaDescartadaAt === null
        ? [
            fila({
              canalOrigen: CanalOrigen.KIOSKO,
              llegadaAnunciadaAt: null,
              presenteDesdeAt: hace30,
              llamadoMostrador: undefined,
              llamadoPor: undefined,
            }),
          ]
        : [],
    );

    const res = await svc.obtenerMonitor(5);

    expect(res.cola[0].clienteEnTienda).toBe(true);
    expect(res.cola[0].esperandoDesdeMin).toBe(30);
    expect(res.contadores.enTienda).toBe(1);
  });
});

/**
 * F22: el contador `sinCliente` ahora es el mismo predicado que la lista "Sin
 * aviso" de la consola. Antes solo contaba web en REVISADO.
 */
describe('MostradorMonitorService — sinCliente (F22)', () => {
  it('cuenta también los que esperan aprobación y los de kiosko descartados', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    // La 4ª consulta de `findMany` es la de sinCliente.
    const where = findMany.mock.calls[2][0].where;
    expect(where.estado).toEqual({
      in: [EstadoPedido.REVISADO, EstadoPedido.ESPERANDO_APROBACION],
    });
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { llegadaDescartadaAt: { not: null } },
        { canalOrigen: CanalOrigen.WEB, llegadaAnunciadaAt: null },
      ]),
    );
  });
});
