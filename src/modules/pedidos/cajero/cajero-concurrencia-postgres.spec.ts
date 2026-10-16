import 'dotenv/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { CajeroService } from './cajero.service';

/**
 * Fase 0 de pagos por transferencia (oct 2026): dos cajeros contra el mismo pedido, con
 * PostgreSQL REAL.
 *
 * El bug (H5): `tomarPedidoCajeroInterno` leía `cajeroAsignadoId` y luego escribía con un
 * `update` por id, sin guarda. Dos cajeros que tomaban el mismo pedido a la vez leían
 * `null` los dos, escribían los dos y los DOS recibían éxito: cada uno creía tener el
 * turno. Y "Llamar siguiente" (buscar + tomar) elegía el mismo pedido para ambos.
 *
 * Un mock de Prisma no sirve aquí: lo que importa es qué hace el `where` de un
 * `updateMany` cuando otra transacción tiene la fila bloqueada.
 */

jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

let tiendaId: number;
let clienteId: number;
let cajeroA: { userId: number; nombre: string; rol: RolUsuario; tiendaId: number };
let cajeroB: typeof cajeroA;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let consecutivo = 0;

function servicio() {
  const ventanillas = {
    ventanillaDelCajero: jest.fn().mockImplementation(async (userId: number) => ({
      id: userId,
      numero: userId % 100,
    })),
  };
  return new CajeroService(prisma as never, realtime as never, {} as never, ventanillas as never);
}

async function crearPedido(
  opts: { estado?: EstadoPedido; modo?: ModoEntrega; antiguedadMin?: number } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-C${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado: opts.estado ?? EstadoPedido.PENDIENTE_PAGO,
      modoEntrega: opts.modo ?? ModoEntrega.RECOGER_TIENDA,
      fechaPedido: new Date(Date.now() - (opts.antiguedadMin ?? 0) * 60_000),
      clienteNombre: 'Cliente Test',
      clienteEmail: `caja-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
    },
  });
  pedidoIds.push(p.id);
  return p;
}

async function crearCajero(n: number) {
  const u = await prisma.usuario.create({
    data: {
      email: `cajero${n}-${suffix}@test.local`,
      password: 'solo-para-pruebas',
      nombre: `Cajero ${n}`,
      rol: RolUsuario.CAJERO,
      tiendaId,
    },
  });
  usuarioIds.push(u.id);
  return { userId: u.id, nombre: u.nombre, rol: RolUsuario.CAJERO, tiendaId };
}

beforeAll(async () => {
  await prisma.$connect();
  const tienda = await prisma.tienda.create({
    data: { nombre: `Caja test ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;
  const cliente = await prisma.usuario.create({
    data: {
      email: `caja-cliente-${suffix}@test.local`,
      password: 'solo-para-pruebas',
      nombre: 'Cliente',
      rol: RolUsuario.CLIENTE,
    },
  });
  clienteId = cliente.id;
  usuarioIds.push(cliente.id);
  cajeroA = await crearCajero(1);
  cajeroB = await crearCajero(2);
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Cada prueba arranca con la cola de la tienda vacía: "Llamar siguiente" toma el más
  // antiguo, y un pedido sobrante de otra prueba le cambiaría el resultado.
  await prisma.pedido.updateMany({
    where: { tiendaId, estado: EstadoPedido.PENDIENTE_PAGO },
    data: { estado: EstadoPedido.CANCELADO, cajeroAsignadoId: null },
  });
});

describe('Cajero — dos ventanillas contra el mismo pedido (H5)', () => {
  it('tomar simultáneo: EXACTAMENTE uno gana y el otro recibe 409', async () => {
    // Se repite: una carrera que sale bien una vez no demuestra nada.
    for (let i = 0; i < 8; i++) {
      const p = await crearPedido();
      const svc = servicio();
      const [ra, rb] = await Promise.allSettled([
        svc.tomarPedidoCajero(p.id, cajeroA),
        svc.tomarPedidoCajero(p.id, cajeroB),
      ]);

      const ganadores = [ra, rb].filter((r) => r.status === 'fulfilled');
      const perdedores = [ra, rb].filter((r) => r.status === 'rejected');
      expect(ganadores).toHaveLength(1);
      expect(perdedores).toHaveLength(1);
      expect((perdedores[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      const fila = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
      const idGanador = ra.status === 'fulfilled' ? cajeroA.userId : cajeroB.userId;
      expect(fila.cajeroAsignadoId).toBe(idGanador);
      // Una sola fila de historial: la del que ganó.
      expect(await prisma.historialPedido.count({ where: { pedidoId: p.id } })).toBe(1);
    }
  });

  it('volver a tomar un pedido propio sigue siendo válido', async () => {
    const p = await crearPedido();
    const svc = servicio();
    await svc.tomarPedidoCajero(p.id, cajeroA);
    await expect(svc.tomarPedidoCajero(p.id, cajeroA)).resolves.toBeDefined();
  });

  it('un pedido ya asignado a otro cajero se rechaza con 409', async () => {
    const p = await crearPedido();
    const svc = servicio();
    await svc.tomarPedidoCajero(p.id, cajeroA);
    await expect(svc.tomarPedidoCajero(p.id, cajeroB)).rejects.toThrow(ConflictException);
  });

  it('no se toma un pedido que ya no está en PENDIENTE_PAGO', async () => {
    const p = await crearPedido({ estado: EstadoPedido.PAGADO });
    await expect(servicio().tomarPedidoCajero(p.id, cajeroA)).rejects.toThrow(/PENDIENTE_PAGO/);
  });

  it('Llamar siguiente simultáneo con DOS pedidos: cada cajero recibe uno DISTINTO', async () => {
    const viejo = await crearPedido({ antiguedadMin: 10 });
    const nuevo = await crearPedido({ antiguedadMin: 5 });
    const svc = servicio();

    const [ra, rb] = await Promise.all([
      svc.llamarSiguiente(cajeroA),
      svc.llamarSiguiente(cajeroB),
    ]);

    // Antes: los dos obtenían el pedido más viejo y el segundo pisaba al primero.
    expect(new Set([ra.pedidoId, rb.pedidoId])).toEqual(new Set([viejo.id, nuevo.id]));
    const filas = await prisma.pedido.findMany({ where: { id: { in: [viejo.id, nuevo.id] } } });
    expect(new Set(filas.map((f) => f.cajeroAsignadoId))).toEqual(
      new Set([cajeroA.userId, cajeroB.userId]),
    );
  });

  it('Llamar siguiente simultáneo con UN pedido: uno lo toma y el otro se queda sin turno', async () => {
    const unico = await crearPedido();
    const svc = servicio();

    const [ra, rb] = await Promise.allSettled([
      svc.llamarSiguiente(cajeroA),
      svc.llamarSiguiente(cajeroB),
    ]);

    const ganadores = [ra, rb].filter((r) => r.status === 'fulfilled');
    const perdedores = [ra, rb].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ganadores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);
    // El que pierde reintenta, ya no encuentra nada y se entera de que no hay cola.
    expect(perdedores[0].reason).toBeInstanceOf(NotFoundException);

    const fila = await prisma.pedido.findUniqueOrThrow({ where: { id: unico.id } });
    expect([cajeroA.userId, cajeroB.userId]).toContain(fila.cajeroAsignadoId);
  });

  it('Llamar siguiente no toma pedidos a domicilio', async () => {
    await crearPedido({ modo: ModoEntrega.DOMICILIO });
    await expect(servicio().llamarSiguiente(cajeroA)).rejects.toThrow(NotFoundException);
  });
});
