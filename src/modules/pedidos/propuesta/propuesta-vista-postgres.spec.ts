import 'dotenv/config';
import {
  CanalOrigen,
  EstadoPedido,
  EstadoPropuesta,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PropuestaService } from './propuesta.service';
import { PedidoAccessService } from '../core/pedido-access.service';

/**
 * Oct 2026 (3c): el cliente ABRIÓ la propuesta — contra PostgreSQL REAL.
 *
 * Lo que un mock no puede decir es si el `where: { vistaAt: null, estado: PENDIENTE }`
 * del `updateMany` hace lo que promete sobre filas de verdad: que la PRIMERA apertura
 * gane, que repetirla no mueva la fecha ni vuelva a avisar, y que una propuesta ya
 * resuelta no se marque. Mismo patrón que `mostrador-flujo-postgres.spec.ts`: crea sus
 * filas y las borra al terminar.
 */

jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

let tiendaId: number;
let clienteId: number;
let otroClienteId: number;
let bodegueroId: number;
let svc: PropuestaService;
const pedidoIds: number[] = [];
let consecutivo = 0;

const cliente = () => ({
  userId: clienteId,
  nombre: 'Cliente',
  rol: RolUsuario.CLIENTE,
  tiendaId: undefined,
});

async function crearPropuesta(estado: EstadoPropuesta = EstadoPropuesta.PENDIENTE) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-V${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado: EstadoPedido.ESPERANDO_APROBACION,
      canalOrigen: CanalOrigen.WEB,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'Cliente Vista',
      clienteEmail: `vista-${suffix}-${consecutivo}@test.local`,
      subtotal: 100,
      total: 100,
    },
  });
  pedidoIds.push(p.id);
  const propuesta = await prisma.pedidoPropuesta.create({
    data: {
      pedidoId: p.id,
      creadaPorId: bodegueroId,
      creadaPorRol: RolUsuario.BODEGA,
      estado,
      items: [],
      total: 100,
    },
  });
  return { pedido: p, propuesta };
}

const leer = (id: number) => prisma.pedidoPropuesta.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  await prisma.$connect();
  const tienda = await prisma.tienda.create({
    data: { nombre: `Vista ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;
  const mk = (email: string, rol: 'CLIENTE' | 'BODEGA') =>
    prisma.usuario.create({
      data: {
        email: `${email}-${suffix}@test.local`,
        password: 'integration-test-only',
        nombre: email,
        rol,
        ...(rol === 'BODEGA' ? { tiendaId } : {}),
      },
    });
  clienteId = (await mk('vista-cli', 'CLIENTE')).id;
  otroClienteId = (await mk('vista-otro', 'CLIENTE')).id;
  bodegueroId = (await mk('vista-bod', 'BODEGA')).id;

  svc = new PropuestaService(
    prisma as never,
    realtime as never,
    new PedidoAccessService(prisma as never),
    {} as never, // state
    {} as never, // reposicion
    {} as never, // precios
    { enviar: jest.fn() } as never, // notifications
  );
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({
    where: { id: { in: [clienteId, otroClienteId, bodegueroId] } },
  });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  realtime.emitToTienda.mockClear();
  realtime.emitToPedido.mockClear();
});

describe('marcarVista: el cliente abrió la propuesta', () => {
  it('la primera apertura fija la fecha y avisa a mostrador', async () => {
    const { pedido, propuesta } = await crearPropuesta();
    expect(propuesta.vistaAt).toBeNull();

    const r = await svc.marcarVista(pedido.id, propuesta.id, cliente());

    expect(r.marcada).toBe(true);
    expect((await leer(propuesta.id)).vistaAt).toBeInstanceOf(Date);
    const payload = { pedidoId: pedido.id, propuestaId: propuesta.id };
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaId, 'propuesta.vista', payload);
    expect(realtime.emitToPedido).toHaveBeenCalledWith(pedido.id, 'propuesta.vista', payload);
  });

  it('abrirla otra vez NO mueve la fecha ni vuelve a avisar', async () => {
    const { pedido, propuesta } = await crearPropuesta();
    await svc.marcarVista(pedido.id, propuesta.id, cliente());
    const primera = (await leer(propuesta.id)).vistaAt;
    realtime.emitToTienda.mockClear();

    const r = await svc.marcarVista(pedido.id, propuesta.id, cliente());

    expect(r.marcada).toBe(false);
    expect((await leer(propuesta.id)).vistaAt).toEqual(primera);
    expect(realtime.emitToTienda).not.toHaveBeenCalled();
  });

  it('dos aperturas simultáneas: solo una marca y solo una avisa', async () => {
    const { pedido, propuesta } = await crearPropuesta();

    const r = await Promise.all([
      svc.marcarVista(pedido.id, propuesta.id, cliente()),
      svc.marcarVista(pedido.id, propuesta.id, cliente()),
    ]);

    expect(r.filter((x) => x.marcada)).toHaveLength(1);
    expect(realtime.emitToTienda).toHaveBeenCalledTimes(1);
  });

  it('una propuesta ya resuelta no se marca', async () => {
    const { pedido, propuesta } = await crearPropuesta(EstadoPropuesta.ACEPTADA);

    const r = await svc.marcarVista(pedido.id, propuesta.id, cliente());

    expect(r.marcada).toBe(false);
    expect((await leer(propuesta.id)).vistaAt).toBeNull();
  });

  it('no marca una propuesta de OTRO pedido aunque el id exista', async () => {
    const a = await crearPropuesta();
    const b = await crearPropuesta();

    const r = await svc.marcarVista(a.pedido.id, b.propuesta.id, cliente());

    expect(r.marcada).toBe(false);
    expect((await leer(b.propuesta.id)).vistaAt).toBeNull();
  });

  it('otro cliente no puede marcar la propuesta ajena', async () => {
    const { pedido, propuesta } = await crearPropuesta();

    await expect(
      svc.marcarVista(pedido.id, propuesta.id, {
        userId: otroClienteId,
        nombre: 'Otro',
        rol: RolUsuario.CLIENTE,
      } as never),
    ).rejects.toBeDefined();
    expect((await leer(propuesta.id)).vistaAt).toBeNull();
  });
});
