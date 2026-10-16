import 'dotenv/config';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { BodegaPresenciaService } from './bodega-presencia.service';
import { MonitorService } from '../pedidos/bodega/monitor.service';

/**
 * Oct 2026 contra PostgreSQL REAL: la presencia del bodeguero en la TV de bodega.
 *
 * Lo que importa: entrar lo pone en la TV, salir lo quita Y regresa a la cola lo que traía (sin
 * pisar lo ajeno), un latido rezagado no lo revive después de cerrar sesión, y el barrido saca
 * solo a quien lleva 15 min callado. Las guardas viven en `where` de un `updateMany`, que un mock
 * de Prisma no puede comprobar.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };
let tiendaId: number;
let clienteId: number;
let rosa: number;
let beto: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];

const svc = () => new BodegaPresenciaService(prisma as never, realtime as never);
const monitor = () => new MonitorService(prisma as never);
const hace = (min: number) => new Date(Date.now() - min * 60_000);

async function bodeguero(nombre: string) {
  const u = await prisma.usuario.create({
    data: {
      email: `${nombre}-${suffix}@test.local`,
      password: 'x',
      nombre,
      rol: RolUsuario.BODEGA,
      tiendaId,
      lastLogin: new Date(),
    },
  });
  usuarioIds.push(u.id);
  return u.id;
}

async function pedidoDe(
  bodegueroId: number,
  extra: { estado?: EstadoPedido; turnoDesde?: Date | null; acumuladoMs?: number } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-B${suffix}-${pedidoIds.length}`,
      usuarioId: clienteId,
      tiendaId,
      estado: extra.estado ?? EstadoPedido.EN_REVISION,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'C',
      clienteEmail: 'c@test.local',
      subtotal: 1,
      total: 1,
      asignadoAId: bodegueroId,
      asignadoAt: hace(10),
      bodegaTurnoDesdeAt: extra.turnoDesde === undefined ? hace(10) : extra.turnoDesde,
      tiempoAtencionBodegaMs: extra.acumuladoMs ?? 0,
    },
  });
  pedidoIds.push(p.id);
  return p;
}

const heartbeatDe = async (id: number) =>
  (await prisma.usuario.findUnique({ where: { id } }))!.ultimoHeartbeat;
const equipoEnTv = async () => (await monitor().obtenerMonitor(tiendaId)).equipo.map((b) => b.id);

async function conSesionAbierta(id: number) {
  await prisma.refreshToken.create({
    data: {
      usuarioId: id,
      tokenHash: `${suffix}${id}`.padEnd(64, 'a'),
      familyId: `fam-${suffix}-${id}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

beforeAll(async () => {
  const t = await prisma.tienda.create({
    data: { nombre: `Presencia bodega ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = t.id;
  const c = await prisma.usuario.create({
    data: {
      email: `cli-b-${suffix}@test.local`,
      password: 'x',
      nombre: 'Cli',
      rol: RolUsuario.CLIENTE,
    },
  });
  clienteId = c.id;
  usuarioIds.push(c.id);
  rosa = await bodeguero('rosa');
  beto = await bodeguero('beto');
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await prisma.refreshToken.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
  await prisma.pedido.updateMany({
    where: { id: { in: pedidoIds } },
    data: { asignadoAId: null, asignadoAt: null },
  });
  await prisma.usuario.updateMany({
    where: { id: { in: [rosa, beto] } },
    data: { ultimoHeartbeat: null },
  });
});

describe('Presencia de bodega — entrar y salir de la TV', () => {
  it('haber iniciado sesión hace horas NO basta: sin latido no sale en la TV', async () => {
    // Antes (ventana de 12 h sobre lastLogin) Rosa aparecía solo por haber entrado hoy.
    expect(await equipoEnTv()).toEqual([]);
  });

  it('entrar la pone en la TV y avisa a la tienda', async () => {
    await svc().entro(rosa, tiendaId);
    expect(await equipoEnTv()).toEqual([rosa]);
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaId, 'bodeguero.entro', {
      usuarioId: rosa,
    });
  });

  it('salir la quita de la TV, avisa, y sus pedidos regresan a la cola sin asignar', async () => {
    await svc().entro(rosa, tiendaId);
    const a = await pedidoDe(rosa);
    const b = await pedidoDe(rosa);
    jest.clearAllMocks();

    const r = await svc().salio(rosa);

    expect(r.pedidosRegresados).toBe(2);
    expect(await heartbeatDe(rosa)).toBeNull();
    expect(await equipoEnTv()).toEqual([]);
    for (const p of [a, b]) {
      const despues = await prisma.pedido.findUnique({
        where: { id: p.id },
        include: { historial: true },
      });
      expect(despues!.asignadoAId).toBeNull();
      expect(despues!.asignadoAt).toBeNull();
      expect(despues!.estado).toBe(EstadoPedido.EN_REVISION);
      expect(despues!.historial.at(-1)!.observacion).toMatch(/salió de bodega/);
    }
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaId,
      'pedido.liberado',
      expect.objectContaining({ id: a.id, liberadoPor: 'rosa' }),
    );
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaId, 'bodeguero.salio', {
      usuarioId: rosa,
    });
  });

  it('no toca los pedidos de otro bodeguero ni los que ya no están en sus manos', async () => {
    await svc().entro(rosa, tiendaId);
    await svc().entro(beto, tiendaId);
    const deBeto = await pedidoDe(beto);
    // ESPERANDO_APROBACION no ocupa slot de bodega: el pedido es del cliente, no está "en sus manos".
    const esperando = await pedidoDe(rosa, { estado: EstadoPedido.ESPERANDO_APROBACION });

    await svc().salio(rosa);

    expect((await prisma.pedido.findUnique({ where: { id: deBeto.id } }))!.asignadoAId).toBe(beto);
    expect((await prisma.pedido.findUnique({ where: { id: esperando.id } }))!.asignadoAId).toBe(
      rosa,
    );
    expect(await equipoEnTv()).toEqual([beto]);
  });

  it('pausa el reloj de atención: el tiempo que ya trabajó queda acumulado', async () => {
    await svc().entro(rosa, tiendaId);
    const p = await pedidoDe(rosa, { acumuladoMs: 60_000, turnoDesde: hace(5) });

    await svc().salio(rosa);

    const despues = await prisma.pedido.findUnique({ where: { id: p.id } });
    expect(despues!.bodegaTurnoDesdeAt).toBeNull();
    // 1 min de antes + ~5 min del turno que dejó corriendo.
    expect(despues!.tiempoAtencionBodegaMs).toBeGreaterThanOrEqual(60_000 + 4.9 * 60_000);
  });

  it('es idempotente: salir dos veces no repite avisos ni escribe historial de más', async () => {
    await svc().entro(rosa, tiendaId);
    const p = await pedidoDe(rosa);
    await svc().salio(rosa);
    jest.clearAllMocks();

    const r = await svc().salio(rosa);

    expect(r.pedidosRegresados).toBe(0);
    const historial = await prisma.historialPedido.count({ where: { pedidoId: p.id } });
    expect(historial).toBe(1);
  });

  it('un rol que no es BODEGA no tiene presencia que quitar', async () => {
    const r = await svc().salio(clienteId);
    expect(r.pedidosRegresados).toBe(0);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });
});

describe('Presencia de bodega — el latido', () => {
  it('renueva la marca de quien ya está en línea, sin avisar de nuevo', async () => {
    await svc().entro(rosa, tiendaId);
    jest.clearAllMocks();
    await svc().latido(rosa);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
    expect(await equipoEnTv()).toEqual([rosa]);
  });

  it('con sesión abierta, un latido revive a quien el barrido sacó y lo avisa', async () => {
    await conSesionAbierta(rosa);
    await prisma.usuario.update({ where: { id: rosa }, data: { ultimoHeartbeat: hace(40) } });
    await svc().latido(rosa);
    expect(await equipoEnTv()).toEqual([rosa]);
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaId, 'bodeguero.entro', {
      usuarioId: rosa,
    });
  });

  it('un latido rezagado DESPUÉS de cerrar sesión no la vuelve a poner en la TV', async () => {
    // Sin sesión abierta (cerrar sesión revoca los refresh tokens).
    await svc().latido(rosa);
    expect(await heartbeatDe(rosa)).toBeNull();
    expect(await equipoEnTv()).toEqual([]);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });
});

describe('Presencia de bodega — el barrido de inactividad', () => {
  it('saca solo a quien lleva más de 15 min sin latido, con sus pedidos', async () => {
    await prisma.usuario.update({ where: { id: rosa }, data: { ultimoHeartbeat: hace(20) } });
    await svc().entro(beto, tiendaId); // beto sí está al día
    const p = await pedidoDe(rosa);
    const deBeto = await pedidoDe(beto);

    const n = await svc().salirInactivos();

    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.asignadoAId).toBeNull();
    expect((await prisma.pedido.findUnique({ where: { id: deBeto.id } }))!.asignadoAId).toBe(beto);
    expect(await heartbeatDe(rosa)).toBeNull();
    expect(await equipoEnTv()).toEqual([beto]);
  });

  it('antes de que el barrido lo saque, quien aún trae pedidos NO desaparece de la TV con ellos', async () => {
    // Latido caducado (16 min) pero el barrido corre cada 5: durante esos minutos sus pedidos no
    // salen en las columnas (viven en su ficha), así que su ficha tiene que seguir.
    await prisma.usuario.update({ where: { id: rosa }, data: { ultimoHeartbeat: hace(16) } });
    await pedidoDe(rosa);
    expect(await equipoEnTv()).toEqual([rosa]);
  });

  it('un latido caducado y sin pedidos ya no cuenta como presente', async () => {
    await prisma.usuario.update({ where: { id: rosa }, data: { ultimoHeartbeat: hace(16) } });
    expect(await equipoEnTv()).toEqual([]);
  });
});
