import { CanalOrigen, EstadoPedido } from '@prisma/client';
import { MonitorService } from './monitor.service';

/**
 * Oct 2026: la TV de bodega le dice al encargado qué pedidos tienen al cliente YA EN LA TIENDA.
 *
 * Antes la TV ordenaba y medía por antigüedad del pedido y no sabía nada de presencia: un pedido
 * web cuyo cliente acababa de entrar y avisó su llegada se veía igual que uno que nadie iba a
 * recoger hoy, mientras la consola de bodega sí lo priorizaba. El encargado no tenía cómo ver que
 * había alguien de pie esperando.
 */

const minAtras = (n: number) => new Date(Date.now() - n * 60_000);

function pedido(o: {
  id: number;
  canal: CanalOrigen;
  creadoHaceMin: number;
  avisoHaceMin?: number;
  descartado?: boolean;
  estado?: EstadoPedido;
}) {
  return {
    id: o.id,
    numeroPedido: `PD-${o.id}`,
    estado: o.estado ?? EstadoPedido.SOLICITADO,
    canalOrigen: o.canal,
    clienteNombre: `Cliente ${o.id}`,
    total: 100,
    fechaPedido: minAtras(o.creadoHaceMin),
    asignadoAt: null,
    asignadoAId: null,
    asignadoA: null,
    llegadaAnunciadaAt: o.avisoHaceMin !== undefined ? minAtras(o.avisoHaceMin) : null,
    llegadaDescartadaAt: o.descartado ? minAtras(1) : null,
    // Un pedido de kiosko nace presente (hora del pedido); el web, al avisar.
    presenteDesdeAt:
      o.canal === CanalOrigen.KIOSKO
        ? minAtras(o.creadoHaceMin)
        : o.avisoHaceMin !== undefined
          ? minAtras(o.avisoHaceMin)
          : null,
    cajeroAsignadoId: null,
    cajeroAsignadoAt: null,
    cajeroAsignado: null,
    _count: { items: 1 },
    items: [],
    historial: [],
  };
}

function crearServicio(pedidos: ReturnType<typeof pedido>[], equipo: unknown[] = []) {
  const prisma = {
    tienda: { findUnique: jest.fn().mockResolvedValue({ id: 5, nombre: 'Mexicali' }) },
    usuario: { findMany: jest.fn().mockResolvedValue(equipo) },
    pedido: { findMany: jest.fn().mockResolvedValue(pedidos) },
    // Sin pedidos en proceso, el cálculo de sugerencias sale temprano.
    itemPedido: { findMany: jest.fn().mockResolvedValue([]) },
    producto: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { svc: new MonitorService(prisma as never), prisma };
}

describe('Monitor de bodega — el cliente en tienda', () => {
  it('kiosko está presente; web solo con aviso de llegada vigente', async () => {
    const { svc } = crearServicio([
      pedido({ id: 1, canal: CanalOrigen.KIOSKO, creadoHaceMin: 3 }),
      pedido({ id: 2, canal: CanalOrigen.WEB, creadoHaceMin: 30 }),
      pedido({ id: 3, canal: CanalOrigen.WEB, creadoHaceMin: 30, avisoHaceMin: 2 }),
    ]);
    const snap = await svc.obtenerMonitor(5);
    const porId = new Map([...snap.pedidosTienda, ...snap.pedidosWeb].map((p) => [p.id, p]));
    expect(porId.get(1)!.clienteEnTienda).toBe(true);
    expect(porId.get(2)!.clienteEnTienda).toBe(false);
    expect(porId.get(2)!.presenteDesdeAt).toBeNull();
    expect(porId.get(3)!.clienteEnTienda).toBe(true);
    expect(porId.get(3)!.presenteDesdeAt).not.toBeNull();
  });

  it('un aviso DESCARTADO ya no cuenta (el cliente no estaba)', async () => {
    const { svc } = crearServicio([
      pedido({
        id: 3,
        canal: CanalOrigen.WEB,
        creadoHaceMin: 30,
        avisoHaceMin: 10,
        descartado: true,
      }),
    ]);
    const snap = await svc.obtenerMonitor(5);
    expect(snap.pedidosWeb[0].clienteEnTienda).toBe(false);
  });

  it('en la columna WEB el cliente presente va primero, aunque su pedido sea más reciente', async () => {
    const { svc } = crearServicio([
      pedido({ id: 10, canal: CanalOrigen.WEB, creadoHaceMin: 90 }), // el más viejo, nadie vino
      pedido({ id: 11, canal: CanalOrigen.WEB, creadoHaceMin: 40, avisoHaceMin: 1 }), // ya llegó
    ]);
    const snap = await svc.obtenerMonitor(5);
    expect(snap.pedidosWeb.map((p) => p.id)).toEqual([11, 10]);
  });

  it('dentro de los presentes, el que lleva más esperando va arriba', async () => {
    const { svc } = crearServicio([
      pedido({ id: 20, canal: CanalOrigen.WEB, creadoHaceMin: 60, avisoHaceMin: 2 }),
      pedido({ id: 21, canal: CanalOrigen.WEB, creadoHaceMin: 20, avisoHaceMin: 7 }),
    ]);
    const snap = await svc.obtenerMonitor(5);
    expect(snap.pedidosWeb.map((p) => p.id)).toEqual([21, 20]);
  });

  it('entre los que llegaron en el mismo minuto, va primero el que llegó antes (no el pedido más viejo)', async () => {
    // Los dos llevan 0 minutos "enteros" esperando: antes empataban y ganaba el de la fecha del
    // pedido, aunque hubiera llegado después.
    const llego = (id: number, creadoHaceMin: number, segAtras: number) => ({
      ...pedido({ id, canal: CanalOrigen.WEB, creadoHaceMin }),
      llegadaAnunciadaAt: new Date(Date.now() - segAtras * 1000),
      presenteDesdeAt: new Date(Date.now() - segAtras * 1000),
    });
    const { svc } = crearServicio([
      llego(50, 90, 8), // pedido MUY viejo, llegó hace 8 s
      llego(51, 10, 40), // pedido reciente, llegó hace 40 s: va primero
    ]);
    const snap = await svc.obtenerMonitor(5);
    expect(snap.pedidosWeb.map((p) => p.id)).toEqual([51, 50]);
  });

  it('el tiempo de un cliente presente cuenta desde que llegó, no desde que se hizo el pedido', async () => {
    // Hecho hace 3 h, llegó hace 2 min: no está "180 min crítico", lleva 2 min con alguien de pie.
    const { svc } = crearServicio([
      pedido({ id: 30, canal: CanalOrigen.WEB, creadoHaceMin: 180, avisoHaceMin: 2 }),
    ]);
    const [p] = (await svc.obtenerMonitor(5)).pedidosWeb;
    expect(p.minutosEnCola).toBeGreaterThanOrEqual(1);
    expect(p.minutosEnCola).toBeLessThanOrEqual(3);
    expect(p.nivelUrgencia).toBe(0);
  });

  it('un cliente web presente se mide con los umbrales de tienda (4 min = aviso), no los de web (5)', async () => {
    const presente = pedido({ id: 40, canal: CanalOrigen.WEB, creadoHaceMin: 30, avisoHaceMin: 4 });
    const ausente = pedido({ id: 41, canal: CanalOrigen.WEB, creadoHaceMin: 4 });
    const { svc } = crearServicio([presente, ausente]);
    const snap = await svc.obtenerMonitor(5);
    const porId = new Map(snap.pedidosWeb.map((p) => [p.id, p]));
    expect(porId.get(40)!.nivelUrgencia).toBe(1);
    expect(porId.get(41)!.nivelUrgencia).toBe(0);
  });

  it('los contadores cuentan los clientes de pie, en la cola y en manos de un bodeguero', async () => {
    const bodeguero = {
      id: 7,
      nombre: 'Luis',
      apellido: null,
      activo: true,
      lastLogin: new Date(),
      pedidosAsignados: [
        {
          id: 99,
          numeroPedido: 'PD-99',
          estado: EstadoPedido.EN_REVISION,
          asignadoAt: minAtras(5),
          canalOrigen: CanalOrigen.WEB,
          llegadaAnunciadaAt: minAtras(3),
          llegadaDescartadaAt: null,
        },
        {
          id: 98,
          numeroPedido: 'PD-98',
          estado: EstadoPedido.EN_REVISION,
          asignadoAt: minAtras(6),
          canalOrigen: CanalOrigen.WEB,
          llegadaAnunciadaAt: null,
          llegadaDescartadaAt: null,
        },
      ],
    };
    const { svc } = crearServicio(
      [
        pedido({ id: 1, canal: CanalOrigen.KIOSKO, creadoHaceMin: 2 }),
        pedido({ id: 2, canal: CanalOrigen.WEB, creadoHaceMin: 9 }),
      ],
      [bodeguero],
    );
    const snap = await svc.obtenerMonitor(5);
    // 1 kiosko en cola + 1 web presente en manos de Luis. El web sin aviso no cuenta.
    expect(snap.contadores.clientesEnTienda).toBe(2);
    const slots = snap.equipo[0].pedidosActuales;
    expect(slots.find((s) => s.id === 99)!.clienteEnTienda).toBe(true);
    expect(slots.find((s) => s.id === 98)!.clienteEnTienda).toBe(false);
  });
});
