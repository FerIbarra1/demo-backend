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
function crearServicio(mostradores: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue([]);

  const prisma = {
    tienda: {
      findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Tienda Test' }),
    },
    pedido: { findMany },
    mostrador: { findMany: jest.fn().mockResolvedValue(mostradores) },
  };

  return { svc: new MostradorMonitorService(prisma as never), findMany };
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
    llamadoMostradorId: 2,
    llamadoMostrador: { numero: 2 },
    ...extra,
  });

  it('el panel Atendiendo lleva el número de mostrador', async () => {
    const { svc, findMany } = crearServicio();
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION ? [fila()] : [],
    );

    const res = await svc.obtenerMonitor(5);

    expect(res.atendiendo[0].mostradorNumero).toBe(2);
  });

  it('sin mostrador válido el número es null (la TV dice solo "Pasa a mostrador")', async () => {
    const { svc, findMany } = crearServicio();
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION
        ? [fila({ llamadoMostradorId: null, llamadoMostrador: null })]
        : [],
    );

    const res = await svc.obtenerMonitor(5);

    expect(res.atendiendo[0].mostradorNumero).toBeNull();
  });
});

/**
 * 16-oct (§9.4): la TV es PÚBLICA. Lo que viaja al navegador de la pared es lo que cualquiera
 * puede leer en la pestaña de red, así que solo sale lo que la pantalla dibuja: folio + números.
 */
describe('MostradorMonitorService — la TV pública solo recibe folio y números', () => {
  const hace = (min: number) => new Date(Date.now() - min * 60_000);

  it('el select de la cola y del panel NO pide nombre, correo, total, canal ni fechas', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    for (const i of [0, 1]) {
      const select = findMany.mock.calls[i][0].select;
      for (const campo of [
        'clienteNombre',
        'clienteEmail',
        'total',
        'canalOrigen',
        'fechaPedido',
        'llegadaAnunciadaAt',
        'llamadoPor',
        '_count',
      ]) {
        expect(select).not.toHaveProperty(campo);
      }
    }
  });

  it('con folio del Sistema Comercial la TV recibe SOLO los últimos 4 dígitos (el folio completo no viaja)', async () => {
    const { svc, findMany } = crearServicio([
      {
        id: 2,
        numero: 2,
        operador: { nombre: 'Ana', apellido: null, lastLogin: hace(1), ultimoHeartbeat: hace(1) },
      },
    ]);
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION
        ? [
            {
              id: 10,
              numeroPedido: 'PD-10',
              folioErp: '0000152573',
              llamadoMostradorId: 2,
              llamadoMostrador: { numero: 2 },
            },
          ]
        : [{ id: 11, numeroPedido: 'PD-11', folioErp: '0000000611' }],
    );
    const r = await svc.obtenerMonitor(5);
    expect(r.cola[0].turno).toBe('0611');
    expect(r.mostradores[0].atendiendo[0].turno).toBe('2573');
    const crudo = JSON.stringify(r);
    expect(crudo).not.toContain('0000152573');
    expect(crudo).not.toContain('folioErp');
  });

  it('cada folio sale como { id, numeroPedido, turno, mostradorNumero } y nada más', async () => {
    const { svc, findMany } = crearServicio([
      {
        id: 2,
        numero: 2,
        operador: { nombre: 'Ana', apellido: null, lastLogin: hace(1), ultimoHeartbeat: hace(1) },
      },
    ]);
    findMany.mockImplementation(async (args: any) =>
      args.where.estado === EstadoPedido.EN_ATENCION
        ? [
            {
              id: 10,
              numeroPedido: 'PD-10',
              llamadoMostradorId: 2,
              llamadoMostrador: { numero: 2 },
            },
          ]
        : [{ id: 11, numeroPedido: 'PD-11' }],
    );

    const r = await svc.obtenerMonitor(5);

    expect(r.cola[0]).toEqual({
      id: 11,
      numeroPedido: 'PD-11',
      turno: null,
      mostradorNumero: null,
    });
    expect(r.mostradores[0].atendiendo[0]).toEqual({
      id: 10,
      numeroPedido: 'PD-10',
      turno: null,
      mostradorNumero: 2,
    });
    expect(Object.keys(r).sort()).toEqual(
      [
        'atendiendo',
        'cola',
        'contadores',
        'mostradores',
        'sinMostrador',
        'tiendaId',
        'tiendaNombre',
        'timestamp',
      ].sort(),
    );
    expect(Object.keys(r.contadores).sort()).toEqual(['atendiendo', 'enCola']);
  });

  it('ya no consulta "listos para entregar" ni "sin recoger": no se pintan y llevaban nombres', async () => {
    const { svc, findMany } = crearServicio();
    await svc.obtenerMonitor(5);
    // Solo dos consultas de pedidos: la cola y el panel Atendiendo.
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('MostradorMonitorService — por mostrador (como la TV de caja)', () => {
  const ahora = () => new Date();
  const hace = (min: number) => new Date(Date.now() - min * 60_000);
  const puesto = (id: number, numero: number, operador: unknown) => ({ id, numero, operador });
  const llamado = (id: number, mostradorId: number | null) => ({
    id,
    numeroPedido: `PD-${id}`,
    llamadoMostradorId: mostradorId,
    llamadoMostrador: mostradorId ? { numero: mostradorId } : null,
  });

  /** El orden de las consultas `pedido.findMany` es: cola, atendiendo. */
  function conLlamados(mostradores: unknown[], atendiendo: unknown[]) {
    const { svc, findMany } = crearServicio(mostradores);
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(atendiendo);
    return svc;
  }

  it('cada folio llamado queda en el mostrador desde el que se llamó', async () => {
    const svc = conLlamados(
      [
        puesto(1, 1, {
          nombre: 'Ana',
          apellido: null,
          lastLogin: ahora(),
          ultimoHeartbeat: ahora(),
        }),
        puesto(2, 2, {
          nombre: 'Luis',
          apellido: null,
          lastLogin: ahora(),
          ultimoHeartbeat: ahora(),
        }),
      ],
      [llamado(10, 2), llamado(11, 1)],
    );
    const r = await svc.obtenerMonitor(5);
    expect(r.mostradores.map((m) => [m.numero, m.atendiendo.map((p) => p.id)])).toEqual([
      [1, [11]],
      [2, [10]],
    ]);
    expect(r.sinMostrador).toHaveLength(0);
  });

  it('un mostrador sin operador, o con +15 min sin señales, sale CERRADO', async () => {
    const svc = conLlamados(
      [
        puesto(1, 1, null),
        puesto(2, 2, {
          nombre: 'Luis',
          apellido: null,
          lastLogin: hace(300),
          ultimoHeartbeat: hace(20),
        }),
        puesto(3, 3, {
          nombre: 'Eva',
          apellido: 'R',
          lastLogin: hace(300),
          ultimoHeartbeat: hace(3),
        }),
      ],
      [],
    );
    const r = await svc.obtenerMonitor(5);
    expect(r.mostradores.map((m) => m.abierto)).toEqual([false, false, true]);
    expect(r.mostradores[2].operadorNombre).toBe('Eva R');
  });

  it('un llamado sin mostrador válido NO desaparece: va en `sinMostrador`', async () => {
    const svc = conLlamados([puesto(1, 1, null)], [llamado(10, null), llamado(11, 99)]);
    const r = await svc.obtenerMonitor(5);
    expect(r.sinMostrador.map((p) => p.id).sort()).toEqual([10, 11]);
    expect(r.mostradores[0].atendiendo).toHaveLength(0);
  });

  it('`atendiendo` plano se conserva (compatibilidad)', async () => {
    const svc = conLlamados([puesto(1, 1, null)], [llamado(10, 1)]);
    expect((await svc.obtenerMonitor(5)).atendiendo).toHaveLength(1);
  });
});
