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
let otraTiendaId: number;
let clienteId: number;
let rosa: number;
let beto: number;
let adminId: number;
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
  extra: {
    estado?: EstadoPedido;
    turnoDesde?: Date | null;
    acumuladoMs?: number;
    /** Por defecto la tienda de las pruebas; el ADMIN puede traer pedidos de otra. */
    tienda?: number;
  } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-B${suffix}-${pedidoIds.length}`,
      usuarioId: clienteId,
      tiendaId: extra.tienda ?? tiendaId,
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

async function conSesionAbierta(id: number, opts: { emitidaHaceMin?: number } = {}) {
  await prisma.refreshToken.create({
    data: {
      usuarioId: id,
      tokenHash: `${suffix}${id}${opts.emitidaHaceMin ?? 0}`.padEnd(64, 'a'),
      familyId: `fam-${suffix}-${id}-${opts.emitidaHaceMin ?? 0}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...(opts.emitidaHaceMin != null ? { createdAt: hace(opts.emitidaHaceMin) } : {}),
    },
  });
}

beforeAll(async () => {
  const t = await prisma.tienda.create({
    data: { nombre: `Presencia bodega ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = t.id;
  const otra = await prisma.tienda.create({
    data: { nombre: `Presencia bodega otra ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  otraTiendaId = otra.id;
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
  // F3.5: el ADMIN no trae tienda en su cuenta; cubre un puesto en la que opera.
  const a = await prisma.usuario.create({
    data: {
      email: `admin-b-${suffix}@test.local`,
      password: 'x',
      nombre: 'Dueño',
      rol: RolUsuario.ADMIN,
      lastLogin: new Date(),
    },
  });
  adminId = a.id;
  usuarioIds.push(a.id);
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaId, otraTiendaId] } } });
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
    where: { id: { in: [rosa, beto, adminId] } },
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

  it('una sesión VIEJA sin revocar (pestaña cerrada sin cerrar sesión, 3 h atrás) NO cuenta como sesión viva', async () => {
    // Con el criterio «sin revocar», un latido rezagado revivía a quien ya no estaba en la tienda hasta por 7 días.
    await conSesionAbierta(rosa, { emitidaHaceMin: 180 });
    expect(await svc().haySesionViva(rosa)).toBe(false);
    await prisma.usuario.update({ where: { id: rosa }, data: { ultimoHeartbeat: hace(40) } });
    await svc().latido(rosa);
    expect(await equipoEnTv()).toEqual([]);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('una sesión reciente (la app abierta rota el refresh cada hora) SÍ es viva; una revocada, no', async () => {
    await conSesionAbierta(rosa, { emitidaHaceMin: 30 });
    expect(await svc().haySesionViva(rosa)).toBe(true);
    await prisma.refreshToken.updateMany({
      where: { usuarioId: rosa },
      data: { revokedAt: new Date() },
    });
    expect(await svc().haySesionViva(rosa)).toBe(false);
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

/**
 * F3.5 (oct 2026, "cubrir puesto"): el ADMIN puede tomar pedidos de bodega. No tiene tienda en su cuenta y
 * puede traer pedidos de varias, así que todo lo anterior —salir, el barrido, la TV— tiene que valer para él
 * sin suponer una tienda propia: sus pedidos no pueden quedar asignados a quien ya no está.
 */
describe('Presencia de bodega — el ADMIN que cubre un puesto', () => {
  it('salir regresa sus pedidos de CADA tienda a la cola y avisa a la tienda de cada pedido', async () => {
    await svc().entro(adminId, null);
    const aqui = await pedidoDe(adminId);
    const alla = await pedidoDe(adminId, { tienda: otraTiendaId });
    jest.clearAllMocks();

    const r = await svc().salio(adminId);

    expect(r.pedidosRegresados).toBe(2);
    expect(await heartbeatDe(adminId)).toBeNull();
    for (const p of [aqui, alla]) {
      const despues = await prisma.pedido.findUnique({
        where: { id: p.id },
        include: { historial: true },
      });
      expect(despues!.asignadoAId).toBeNull();
      expect(despues!.estado).toBe(EstadoPedido.EN_REVISION);
      expect(despues!.historial.at(-1)!.observacion).toMatch(/salió de bodega/);
    }
    // Un ADMIN no tiene tienda propia a la que avisar: el aviso va a la de cada pedido, no a ninguna ni a una sola.
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaId,
      'pedido.liberado',
      expect.objectContaining({ id: aqui.id }),
    );
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      otraTiendaId,
      'pedido.liberado',
      expect.objectContaining({ id: alla.id }),
    );
    // Y no hay ficha de bodeguero que quitar de ninguna TV (no tiene tienda propia).
    expect(realtime.emitToTienda).not.toHaveBeenCalledWith(
      expect.anything(),
      'bodeguero.salio',
      expect.anything(),
    );
  });

  it('`soloPedidos` (cambiar de tienda) los regresa SIN sacarlo de línea ni avisar que se fue', async () => {
    await svc().entro(adminId, null);
    const p = await pedidoDe(adminId);
    jest.clearAllMocks();

    const r = await svc().salio(adminId, { soloPedidos: true });

    expect(r.pedidosRegresados).toBe(1);
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.asignadoAId).toBeNull();
    // Cambiar de tienda no es irse: su latido sigue y sigue con sesión.
    expect(await heartbeatDe(adminId)).not.toBeNull();
    expect(realtime.emitToTienda).not.toHaveBeenCalledWith(
      expect.anything(),
      'bodeguero.salio',
      expect.anything(),
    );
  });

  it('el barrido lo saca como a un bodeguero: con 15 min sin latido sus pedidos regresan a la cola', async () => {
    await prisma.usuario.update({ where: { id: adminId }, data: { ultimoHeartbeat: hace(20) } });
    const p = await pedidoDe(adminId);

    const n = await svc().salirInactivos();

    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.asignadoAId).toBeNull();
    expect(await heartbeatDe(adminId)).toBeNull();
  });

  it('el barrido NO toca al ADMIN que sigue mandando latidos', async () => {
    await prisma.usuario.update({ where: { id: adminId }, data: { ultimoHeartbeat: hace(4) } });
    const p = await pedidoDe(adminId);

    await svc().salirInactivos();

    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.asignadoAId).toBe(adminId);
  });

  it('en la TV de SU tienda sale como un bodeguero más, con sus pedidos de ESA tienda y nada de la otra', async () => {
    await prisma.usuario.update({ where: { id: adminId }, data: { ultimoHeartbeat: new Date() } });
    const aqui = await pedidoDe(adminId);
    const alla = await pedidoDe(adminId, { tienda: otraTiendaId });

    const tvAqui = await monitor().obtenerMonitor(tiendaId);
    const tvAlla = await monitor().obtenerMonitor(otraTiendaId);

    const fichaAqui = tvAqui.equipo.find((b) => b.id === adminId)!;
    expect(fichaAqui.pedidosActuales.map((p) => p.id)).toEqual([aqui.id]);
    const fichaAlla = tvAlla.equipo.find((b) => b.id === adminId)!;
    expect(fichaAlla.pedidosActuales.map((p) => p.id)).toEqual([alla.id]);
  });

  it('sin pedidos en una tienda NO sale en su TV, aunque esté en línea: no es parte de su equipo', async () => {
    await prisma.usuario.update({ where: { id: adminId }, data: { ultimoHeartbeat: new Date() } });
    await pedidoDe(adminId, { tienda: otraTiendaId });

    expect(await equipoEnTv()).toEqual([]);
  });

  it('un pedido suyo que ya no ocupa slot de bodega (esperando al cliente) no lo mete a la TV', async () => {
    await prisma.usuario.update({ where: { id: adminId }, data: { ultimoHeartbeat: new Date() } });
    await pedidoDe(adminId, { estado: EstadoPedido.PENDIENTE_PAGO });
    expect(await equipoEnTv()).toEqual([]);
  });
});
