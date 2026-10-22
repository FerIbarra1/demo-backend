import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { FolioReservaHandler } from './handlers/folio-reserva.handler';
import { PedidoDescargaHandler } from './handlers/pedido-descarga.handler';
import { CatalogHandler } from './handlers/catalog.handler';
import { ExternalRefService } from './external-ref.service';
import { SyncAgentService } from './sync-agent.service';
import { asegurarSolicitudDeFolio } from '../pedidos/core/folio-erp.util';

/**
 * Oct 2026 (parte B) — la cola de folios CONTRA PostgreSQL.
 *
 * Con Prisma mockeado no se ven las cosas que importan aquí: el lease (`updateMany` con `OR`), el filtro
 * `NOT: { folioSolicitud: { is … } }` del poll de pedidos, `createMany + skipDuplicates` y el índice único
 * `(tienda, folio)`. Las dos tiendas existen para probar que el MISMO número de folio sí puede vivir en cada una
 * (el consecutivo del ERP es por tienda) y que dentro de una no puede repetirse.
 */

jest.setTimeout(20_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const emitToTienda = jest.fn();
const emitToPedido = jest.fn();
const realtime = { emitToTienda, emitToPedido } as any;

let usuarioId: number;
const tiendas: Array<{ id: number; externalId: number }> = [];
const pedidoIds: number[] = [];
let n = 0;

async function nuevoPedido(tiendaIdx: number, extra: Record<string, unknown> = {}) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-F${suffix}-${++n}`,
      usuarioId,
      tiendaId: tiendas[tiendaIdx].id,
      clienteNombre: 'Folio test',
      clienteEmail: `folio-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
      ...extra,
    },
  });
  pedidoIds.push(p.id);
  return p;
}

const handler = () => new FolioReservaHandler(prisma as any, realtime);
const ahoraMas = (ms: number) => new Date(Date.now() + ms);

beforeAll(async () => {
  await prisma.$connect();
  for (let i = 0; i < 2; i++) {
    const t = await prisma.tienda.create({
      data: {
        nombre: `Folio test ${suffix}-${i}`,
        direccion: 'Test',
        ciudad: 'Test',
        estado: 'Test',
        serie: i === 0 ? 'TST' : 'TS2',
        externalId: Number(`9${suffix}${i}`),
      },
    });
    tiendas.push({ id: t.id, externalId: t.externalId! });
  }
  const u = await prisma.usuario.create({
    data: {
      email: `folio-${suffix}@test.local`,
      password: 'x',
      nombre: 'Folio test',
      rol: 'CLIENTE',
    },
  });
  usuarioId = u.id;
});

afterAll(async () => {
  await prisma.pedidoPendienteEnvio.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.externalRef.deleteMany({
    where: { systemEntity: 'PEDIDO', systemId: { in: pedidoIds } },
  });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } }); // la solicitud se va en cascada
  await prisma.usuario.deleteMany({ where: { id: usuarioId } });
  await prisma.tienda.deleteMany({ where: { id: { in: tiendas.map((t) => t.id) } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  emitToTienda.mockClear();
  emitToPedido.mockClear();
  // Cada prueba parte de una cola vacía: una solicitud que dejó otra se repartiría en el poll de esta.
  await prisma.pedidoFolioSolicitud.deleteMany({
    where: { tiendaId: { in: tiendas.map((t) => t.id) } },
  });
});

describe('asegurarSolicitudDeFolio', () => {
  it('deja UNA solicitud por pedido aunque se llame varias veces, y ninguna si ya tiene folio', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await asegurarSolicitudDeFolio(prisma, p);
    expect(await prisma.pedidoFolioSolicitud.count({ where: { pedidoId: p.id } })).toBe(1);

    const conFolio = await nuevoPedido(0, { folioErp: '0000000777' });
    await asegurarSolicitudDeFolio(prisma, conFolio);
    expect(await prisma.pedidoFolioSolicitud.count({ where: { pedidoId: conFolio.id } })).toBe(0);
  });
});

describe('poll-folios', () => {
  it('reparte la solicitud con un lease: otro ciclo no la ve hasta que vence', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);

    const primero = await handler().poll(tiendas[0].id, 20, 'agente-A');
    expect(primero.map((s) => s.pedidoId)).toEqual([p.id]);
    expect(primero[0].numeroPedido).toBe(p.numeroPedido);

    expect(await handler().poll(tiendas[0].id, 20, 'agente-B')).toEqual([]);

    // El agente se cayó a medio camino: vence el lease y otro ciclo puede tomarla.
    await prisma.pedidoFolioSolicitud.update({
      where: { pedidoId: p.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const segundo = await handler().poll(tiendas[0].id, 20, 'agente-B');
    expect(segundo.map((s) => s.pedidoId)).toEqual([p.id]);
    expect(
      (await prisma.pedidoFolioSolicitud.findUnique({ where: { pedidoId: p.id } }))!.intentos,
    ).toBe(2);
  });

  it('solo ofrece las de SU tienda', async () => {
    const p = await nuevoPedido(1);
    await asegurarSolicitudDeFolio(prisma, p);
    expect(await handler().poll(tiendas[0].id, 20, 'agente')).toEqual([]);
    expect((await handler().poll(tiendas[1].id, 20, 'agente')).map((s) => s.pedidoId)).toEqual([
      p.id,
    ]);
  });

  it('un pedido cancelado antes de que el agente llegara no gasta un número', async () => {
    const p = await nuevoPedido(0, { estado: 'CANCELADO' });
    await asegurarSolicitudDeFolio(prisma, p);
    expect(await handler().poll(tiendas[0].id, 20, 'agente')).toEqual([]);
  });

  it('un pedido que ya recibió su folio por otro camino tampoco', async () => {
    const p = await nuevoPedido(0, { folioErp: '0000000555' });
    await prisma.pedidoFolioSolicitud.create({ data: { pedidoId: p.id, tiendaId: tiendas[0].id } });
    expect(await handler().poll(tiendas[0].id, 20, 'agente')).toEqual([]);
  });
});

describe('folios-ack', () => {
  const ack = (idxTienda: number, pedidoId: number, extra: Record<string, unknown> = {}) =>
    handler().ack(tiendas[idxTienda].id, {
      tiendaId: tiendas[idxTienda].externalId,
      acks: [{ pedidoId, agentId: 'agente', exito: true, folio: '0000152574', ...extra }],
    } as any);

  it('guarda el folio, cierra la solicitud y avisa a las pantallas (con la serie de la tienda)', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await handler().poll(tiendas[0].id, 20, 'agente');

    expect(await ack(0, p.id)).toEqual({ actualizados: 1, errores: 0 });

    const guardado = await prisma.pedido.findUnique({ where: { id: p.id } });
    expect(guardado!.folioErp).toBe('0000152574');
    const sol = await prisma.pedidoFolioSolicitud.findUnique({ where: { pedidoId: p.id } });
    expect(sol).toMatchObject({ estado: 'ASIGNADO', claimedBy: null, leaseToken: null });
    expect(sol!.asignadoAt).not.toBeNull();

    const payload = { id: p.id, folio: '0000152574', serie: 'TST', etiqueta: 'TST-0000152574' };
    expect(emitToTienda).toHaveBeenCalledWith(tiendas[0].id, 'pedido.folio-asignado', payload);
    expect(emitToPedido).toHaveBeenCalledWith(p.id, 'pedido.folio-asignado', payload);
    // Las TV de pared pintan el turno (cola del folio): un pedido que ya estaba en pantalla se refresca.
    expect(emitToTienda).toHaveBeenCalledWith(tiendas[0].id, 'monitor.invalidado', { pedidoId: p.id });
  });

  it('repetir el ACK es idempotente y NO vuelve a avisar', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await ack(0, p.id, { folio: '0000200001' });
    emitToTienda.mockClear();
    expect(await ack(0, p.id, { folio: '0000200001' })).toEqual({ actualizados: 1, errores: 0 });
    expect(emitToTienda).not.toHaveBeenCalled();
  });

  it('se acepta aunque el lease haya vencido: tirarlo gastaría otro número sin ningún beneficio', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await handler().poll(tiendas[0].id, 20, 'agente');
    await prisma.pedidoFolioSolicitud.update({
      where: { pedidoId: p.id },
      data: { leaseUntil: new Date(Date.now() - 60_000) },
    });
    expect(await ack(0, p.id, { folio: '0000200002' })).toEqual({ actualizados: 1, errores: 0 });
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.folioErp).toBe('0000200002');
  });

  it('si el pedido ya tenía OTRO folio gana ese; el reservado queda como hueco', async () => {
    const p = await nuevoPedido(0, { folioErp: '0000300001' });
    await prisma.pedidoFolioSolicitud.create({ data: { pedidoId: p.id, tiendaId: tiendas[0].id } });
    expect(await ack(0, p.id, { folio: '0000300002' })).toEqual({ actualizados: 1, errores: 0 });
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.folioErp).toBe('0000300001');
    expect(emitToTienda).not.toHaveBeenCalled();
  });

  it('el MISMO número puede vivir en otra tienda, pero no dos veces en la misma', async () => {
    const a = await nuevoPedido(0);
    const b = await nuevoPedido(1);
    const c = await nuevoPedido(0);
    for (const p of [a, b, c]) await asegurarSolicitudDeFolio(prisma, p);

    expect(await ack(0, a.id, { folio: '0000400001' })).toEqual({ actualizados: 1, errores: 0 });
    // Otra tienda, mismo número: es lo normal (cada tienda cuenta desde 1).
    expect(await ack(1, b.id, { folio: '0000400001' })).toEqual({ actualizados: 1, errores: 0 });
    // Misma tienda, número ya usado por OTRO pedido: el consecutivo del ERP está desfasado. No se asigna.
    expect(await ack(0, c.id, { folio: '0000400001' })).toEqual({ actualizados: 0, errores: 1 });
    expect((await prisma.pedido.findUnique({ where: { id: c.id } }))!.folioErp).toBeNull();
    expect(
      (await prisma.pedidoFolioSolicitud.findUnique({ where: { pedidoId: c.id } }))!.estado,
    ).toBe('PENDIENTE');
  });

  it('un fallo del agente regresa la solicitud a PENDIENTE con espera y no se ofrece antes', async () => {
    const p = await nuevoPedido(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await handler().poll(tiendas[0].id, 20, 'agente');

    const r = await handler().ack(tiendas[0].id, {
      tiendaId: tiendas[0].externalId,
      acks: [
        { pedidoId: p.id, agentId: 'agente', exito: false, error: 'CONSECUTIVOS: lock timeout' },
      ],
    } as any);
    expect(r).toEqual({ actualizados: 0, errores: 1 });

    const sol = await prisma.pedidoFolioSolicitud.findUnique({ where: { pedidoId: p.id } });
    expect(sol).toMatchObject({
      estado: 'PENDIENTE',
      ultimoError: 'CONSECUTIVOS: lock timeout',
      leaseToken: null,
    });
    expect(sol!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await handler().poll(tiendas[0].id, 20, 'agente')).toEqual([]);
  });

  it('el ACK de un folio que el pedido YA tiene, aunque no haya solicitud, es idempotente (no un error)', async () => {
    // El respaldo de GRABAR_PEDIDOS asigna el folio sin pasar por la cola: no hay solicitud, pero el pedido ya lo tiene.
    const p = await nuevoPedido(0, { folioErp: '0000900001' });
    expect(await ack(0, p.id, { folio: '0000900001' })).toEqual({ actualizados: 1, errores: 0 });
    // Con otro folio distinto sí es un error: no hay a qué cerrarlo.
    expect(await ack(0, p.id, { folio: '0000900002' })).toEqual({ actualizados: 0, errores: 1 });
  });

  it('rechaza el ACK de un pedido sin solicitud o de otra tienda', async () => {
    const p = await nuevoPedido(1);
    await asegurarSolicitudDeFolio(prisma, p);
    expect(await ack(0, p.id, { folio: '0000500001' })).toEqual({ actualizados: 0, errores: 1 });
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.folioErp).toBeNull();
  });
});

describe('el respaldo: el pedido llega a caja sin folio y GRABAR_PEDIDOS toma uno', () => {
  const descarga = () =>
    new PedidoDescargaHandler(prisma as any, { resolveLocalIds: async () => new Map() } as any);

  async function pedidoEncolado(tiendaIdx: number, extra: Record<string, unknown> = {}) {
    const p = await nuevoPedido(tiendaIdx, { estado: 'PENDIENTE_PAGO', ...extra });
    await prisma.pedidoPendienteEnvio.create({
      data: { pedidoId: p.id, externalIdPEDIDOS: 1_000_000_000 + p.id },
    });
    return p;
  }

  it('el payload lleva el folio que la nube ya tiene (o null si aún no)', async () => {
    const sinFolio = await pedidoEncolado(0);
    const conFolio = await pedidoEncolado(0, { folioErp: '0000600001' });
    const salida = await descarga().poll(tiendas[0].id, 50, 'agente');
    const por = new Map(salida.map((x) => [x.pedidoId, x.folio]));
    expect(por.get(sinFolio.id)).toBeNull();
    expect(por.get(conFolio.id)).toBe('0000600001');
  });

  it('NO manda el pedido mientras el agente tiene en sus manos la reserva de su folio', async () => {
    const p = await pedidoEncolado(0);
    await asegurarSolicitudDeFolio(prisma, p);
    await handler().poll(tiendas[0].id, 20, 'agente'); // PROCESSING con lease vigente
    const salida = await descarga().poll(tiendas[0].id, 50, 'agente');
    expect(salida.map((x) => x.pedidoId)).not.toContain(p.id);

    // Si el agente nunca contesta, al vencer el lease el pedido sigue su camino (con el respaldo).
    await prisma.pedidoFolioSolicitud.update({
      where: { pedidoId: p.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const despues = await descarga().poll(tiendas[0].id, 50, 'agente');
    expect(despues.map((x) => x.pedidoId)).toContain(p.id);
  });

  it('el ACK del pedido guarda el folio que quedó en el ERP y cierra la solicitud', async () => {
    const p = await pedidoEncolado(0);
    await asegurarSolicitudDeFolio(prisma, p);
    const salida = await descarga().poll(tiendas[0].id, 50, 'agente-1');
    const mio = salida.find((x) => x.pedidoId === p.id)!;
    expect(mio).toBeDefined();

    const service = new SyncAgentService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enviarListoParaPagar: jest.fn().mockResolvedValue(undefined) } as any,
      handler(),
    );
    await service.procesarPedidosAck({
      tiendaId: tiendas[0].externalId,
      acks: [
        {
          pedidoId: p.id,
          agentId: 'agente-1',
          leaseToken: mio.leaseToken!,
          exito: true,
          externalIdPEDIDOS: 1_000_000_000 + p.id,
          externalFolio: '0000700001',
        },
      ],
    } as any);

    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.folioErp).toBe('0000700001');
    expect(
      (await prisma.pedidoFolioSolicitud.findUnique({ where: { pedidoId: p.id } }))!.estado,
    ).toBe('ASIGNADO');
    expect(emitToTienda).toHaveBeenCalledWith(
      tiendas[0].id,
      'pedido.folio-asignado',
      expect.objectContaining({ id: p.id, etiqueta: 'TST-0000700001' }),
    );
  });

  it('un folio basura (el "PD-2026-00" del agente anterior) no se guarda como folio', async () => {
    const p = await pedidoEncolado(0);
    const salida = await descarga().poll(tiendas[0].id, 50, 'agente-2');
    const mio = salida.find((x) => x.pedidoId === p.id)!;
    const service = new SyncAgentService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enviarListoParaPagar: jest.fn().mockResolvedValue(undefined) } as any,
      handler(),
    );
    await service.procesarPedidosAck({
      tiendaId: tiendas[0].externalId,
      acks: [
        {
          pedidoId: p.id,
          agentId: 'agente-2',
          leaseToken: mio.leaseToken!,
          exito: true,
          externalIdPEDIDOS: 1_000_000_000 + p.id,
          externalFolio: 'PD-2026-00',
        },
      ],
    } as any);
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.folioErp).toBeNull();
  });
});

describe('el índice único (tienda, folio)', () => {
  it('Postgres deja pasar muchos pedidos SIN folio en una misma tienda', async () => {
    await nuevoPedido(0);
    await nuevoPedido(0);
    await nuevoPedido(0);
  });

  it('rechaza el mismo folio dos veces en una tienda y lo permite en dos tiendas', async () => {
    await nuevoPedido(0, { folioErp: '0000800001' });
    await expect(nuevoPedido(0, { folioErp: '0000800001' })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(nuevoPedido(1, { folioErp: '0000800001' })).resolves.toBeDefined();
  });
});

describe('TIENDAS.SERIE llega con el catálogo (el prefijo visual del folio)', () => {
  const catalogo = () => new CatalogHandler(prisma as any, new ExternalRefService(prisma as any));
  const evento = (localId: number, datos: Record<string, unknown>, operacion = 'U') =>
    ({
      tipo: 'CATALOGO',
      entidad: 'TIENDAS',
      operacion,
      localId,
      datos,
      eventId: `e-${localId}-${operacion}`,
    }) as any;
  const ext = () => Number(`8${suffix}`);

  afterAll(async () => {
    await prisma.externalRef.deleteMany({
      where: { systemEntity: 'TIENDA', localEntity: 'TIENDAS', localId: ext() },
    });
    await prisma.tienda.deleteMany({ where: { externalId: ext() } });
  });

  it('una tienda nueva nace con su serie (en mayúsculas)', async () => {
    const r = await catalogo().procesar(
      evento(ext(), { NOMBRE: `Serie ${suffix}`, SERIE: ' hmo ' }, 'I'),
    );
    expect(r.ok).toBe(true);
    expect((await prisma.tienda.findUnique({ where: { externalId: ext() } }))!.serie).toBe('HMO');
  });

  it('un cambio en la tienda SIN serie en el evento no la borra', async () => {
    await catalogo().procesar(evento(ext(), { NOMBRE: `Serie ${suffix} renombrada` }));
    const t = await prisma.tienda.findUnique({ where: { externalId: ext() } });
    expect(t!.nombre).toBe(`Serie ${suffix} renombrada`);
    expect(t!.serie).toBe('HMO');
  });

  it('si la serie cambia en el ERP, la nube la sigue', async () => {
    await catalogo().procesar(evento(ext(), { NOMBRE: `Serie ${suffix}`, SERIE: 'HMX' }));
    expect((await prisma.tienda.findUnique({ where: { externalId: ext() } }))!.serie).toBe('HMX');
  });
});
