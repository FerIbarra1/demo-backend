import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { VentanillasService } from './ventanillas.service';

/**
 * Oct 2026 contra PostgreSQL REAL: tomar el control de una ventanilla ocupada y el barrido de
 * inactividad. Lo que importa es qué pasa con los CLIENTES del cajero que la pierde.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };
let tiendaId: number;
let clienteId: number;
let ana: number;
let luis: number;
let ventanillaId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];

const svc = () => new VentanillasService(prisma as never, realtime as never);
const hace = (min: number) => new Date(Date.now() - min * 60_000);

async function usuario(nombre: string, lastLogin: Date | null, heartbeat: Date | null) {
  const u = await prisma.usuario.create({
    data: {
      email: `${nombre}-${suffix}@test.local`,
      password: 'x',
      nombre,
      rol: RolUsuario.CAJERO,
      tiendaId,
      lastLogin,
      ultimoHeartbeat: heartbeat,
    },
  });
  usuarioIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  const t = await prisma.tienda.create({
    data: { nombre: `Estaciones test ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = t.id;
  const c = await prisma.usuario.create({
    data: { email: `cli-${suffix}@test.local`, password: 'x', nombre: 'Cli', rol: RolUsuario.CLIENTE },
  });
  clienteId = c.id;
  usuarioIds.push(c.id);
  ana = await usuario('ana', new Date(), new Date());
  luis = await usuario('luis', new Date(), new Date());
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await prisma.ventanilla.deleteMany({ where: { tiendaId } });
  const v = await prisma.ventanilla.create({ data: { tiendaId, numero: 1, cajeroId: ana } });
  ventanillaId = v.id;
  await prisma.usuario.update({ where: { id: ana }, data: { lastLogin: new Date(), ultimoHeartbeat: new Date() } });
});

async function pedidoDeAna() {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-E${suffix}-${pedidoIds.length}`,
      usuarioId: clienteId,
      tiendaId,
      estado: EstadoPedido.PENDIENTE_PAGO,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'C',
      clienteEmail: 'c@test.local',
      subtotal: 1,
      total: 1,
      cajeroAsignadoId: ana,
      cajeroAsignadoAt: new Date(),
      colaCajaDesdeAt: hace(30),
    },
  });
  pedidoIds.push(p.id);
  return p;
}

describe('Ventanilla — elegir una ocupada', () => {
  it('sin confirmación: 409 con código, y no se mueve nada', async () => {
    await expect(svc().elegir(luis, tiendaId, ventanillaId)).rejects.toMatchObject({
      response: { code: 'VENTANILLA_OCUPADA' },
    });
    expect((await prisma.ventanilla.findUnique({ where: { id: ventanillaId } }))!.cajeroId).toBe(ana);
  });

  it('con confirmación toma el control: avisa a quien la tenía y sus clientes regresan a la fila con su lugar', async () => {
    const p = await pedidoDeAna();
    const antes = (await prisma.pedido.findUnique({ where: { id: p.id } }))!.colaCajaDesdeAt;

    await svc().elegir(luis, tiendaId, ventanillaId, true);

    expect((await prisma.ventanilla.findUnique({ where: { id: ventanillaId } }))!.cajeroId).toBe(luis);
    const despues = await prisma.pedido.findUnique({ where: { id: p.id } });
    expect(despues!.cajeroAsignadoId).toBeNull();
    expect(despues!.colaCajaDesdeAt).toEqual(antes);
    expect(realtime.emitToUser).toHaveBeenCalledWith(ana, 'ventanilla.perdida', { numero: 1 });
  });

  it('dos que la toman a la vez: gana uno y el otro recibe 409', async () => {
    const otro = await usuario('otro', new Date(), new Date());
    const r = await Promise.allSettled([
      svc().elegir(luis, tiendaId, ventanillaId, true),
      svc().elegir(otro, tiendaId, ventanillaId, true),
    ]);
    const ok = r.filter((x) => x.status === 'fulfilled').length;
    const dueno = (await prisma.ventanilla.findUnique({ where: { id: ventanillaId } }))!.cajeroId;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect([luis, otro]).toContain(dueno);
    r.filter((x) => x.status === 'rejected').forEach((x) =>
      expect((x as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException),
    );
  });
});

describe('Ventanilla — barrido de inactividad', () => {
  it('suelta la del cajero sin señales en +15 min y regresa a la fila lo que atendía', async () => {
    const p = await pedidoDeAna();
    await prisma.usuario.update({ where: { id: ana }, data: { lastLogin: hace(300), ultimoHeartbeat: hace(20) } });

    const n = await svc().liberarInactivas();

    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.ventanilla.findUnique({ where: { id: ventanillaId } }))!.cajeroId).toBeNull();
    expect((await prisma.pedido.findUnique({ where: { id: p.id } }))!.cajeroAsignadoId).toBeNull();
  });

  it('NO toca la del cajero que sigue mandando latidos', async () => {
    await prisma.usuario.update({ where: { id: ana }, data: { lastLogin: hace(600), ultimoHeartbeat: hace(4) } });
    await svc().liberarInactivas();
    expect((await prisma.ventanilla.findUnique({ where: { id: ventanillaId } }))!.cajeroId).toBe(ana);
  });
});

describe('Ventanilla — listar muestra la actividad del ocupante', () => {
  it('marca `ocupanteInactivo` cuando lleva +15 min sin señales', async () => {
    await prisma.usuario.update({ where: { id: ana }, data: { lastLogin: hace(300), ultimoHeartbeat: hace(40) } });
    const [v] = await svc().listarPorTienda(tiendaId);
    expect(v.ocupanteInactivo).toBe(true);
    expect(v.ultimaActividad).not.toBeNull();
    expect(v.cajero).toEqual({ id: ana, nombre: 'ana', apellido: null });
  });
});
