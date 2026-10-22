import 'dotenv/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { CajeroService } from '../cajero/cajero.service';
import { CajeroMonitorService } from '../cajero/cajero-monitor.service';
import { BodegaService } from '../bodega/bodega.service';
import { VentanillasService } from '../../ventanillas/ventanillas.service';

/**
 * PLAN-ADMIN-MULTITIENDA §13 (F3.5, oct 2026) contra PostgreSQL REAL: el ADMIN CUBRE UN PUESTO.
 *
 * Con mocks de Prisma se ve la regla; aquí se ve lo que de verdad se escribe: la unicidad de `cajeroId` (una
 * persona, una ventanilla, en cualquier tienda), las guardas que viven en el `where` de un `updateMany` y qué
 * tienda filtra una consulta cuando el ADMIN no trae una en el token. Tres historias:
 *
 *  1. la ventanilla: elegir sin tienda propia, y que cambiar de tienda SUELTE la anterior con su gente;
 *  2. caja: tomar y llamar exigen ventanilla EN LA TIENDA DEL PEDIDO, y llamar elige de la fila de ESA tienda;
 *  3. bodega: `tomarGrupo` ya no toma de cualquier tienda (con `tiendaId: undefined` Prisma no filtra).
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

let tiendaA: number;
let tiendaB: number;
let clienteId: number;
let adminId: number;
let cajeroAId: number;
let admin: { userId: number; nombre: string; rol: RolUsuario; tiendaId: undefined };
let vA1: number;
let vA2: number;
let vB1: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let consecutivo = 0;

const min = (n: number) => new Date(Date.now() - n * 60_000);
const ventanillas = () => new VentanillasService(prisma as never, realtime as never);
const caja = () =>
  new CajeroService(prisma as never, realtime as never, {} as never, ventanillas());
const nada = () =>
  new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`tomarGrupo no debía tocar "${String(p)}"`);
      },
    },
  );
const bodega = () =>
  new BodegaService(prisma as never, realtime as never, nada() as never, nada() as never);

async function usuario(nombre: string, rol: RolUsuario, tiendaId: number | null) {
  const u = await prisma.usuario.create({
    data: {
      email: `${nombre}-${suffix}@test.local`,
      password: 'x',
      nombre,
      rol,
      tiendaId,
      lastLogin: new Date(),
      ultimoHeartbeat: new Date(),
    },
  });
  usuarioIds.push(u.id);
  return u.id;
}

async function pedido(
  tiendaId: number,
  o: { estado?: EstadoPedido; llegoAHaceMin?: number; cajeroAsignadoId?: number } = {},
) {
  const estado = o.estado ?? EstadoPedido.PENDIENTE_PAGO;
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-X${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'Cliente Test',
      clienteEmail: `cli-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
      ...(estado === EstadoPedido.PENDIENTE_PAGO
        ? {
            colaCajaDesdeAt: min(o.llegoAHaceMin ?? 0),
            ...(o.cajeroAsignadoId
              ? { cajeroAsignadoId: o.cajeroAsignadoId, cajeroAsignadoAt: new Date() }
              : {}),
          }
        : {}),
    },
  });
  pedidoIds.push(p.id);
  return p;
}

const leer = (id: number) => prisma.pedido.findUniqueOrThrow({ where: { id } });
const dueñoDe = async (ventanillaId: number) =>
  (await prisma.ventanilla.findUniqueOrThrow({ where: { id: ventanillaId } })).cajeroId;

beforeAll(async () => {
  const mk = (n: string) =>
    prisma.tienda.create({
      data: { nombre: `Admin puesto ${n} ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
    });
  tiendaA = (await mk('A')).id;
  tiendaB = (await mk('B')).id;
  clienteId = await usuario('cli', RolUsuario.CLIENTE, null);
  adminId = await usuario('admin', RolUsuario.ADMIN, null);
  cajeroAId = await usuario('cajeroA', RolUsuario.CAJERO, tiendaA);
  admin = {
    userId: adminId,
    nombre: 'admin (Administrador)',
    rol: RolUsuario.ADMIN,
    tiendaId: undefined,
  };
});

afterAll(async () => {
  await prisma.ventanilla.deleteMany({ where: { tiendaId: { in: [tiendaA, tiendaB] } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB] } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await prisma.ventanilla.deleteMany({ where: { tiendaId: { in: [tiendaA, tiendaB] } } });
  vA1 = (await prisma.ventanilla.create({ data: { tiendaId: tiendaA, numero: 1 } })).id;
  vA2 = (await prisma.ventanilla.create({ data: { tiendaId: tiendaA, numero: 2 } })).id;
  vB1 = (await prisma.ventanilla.create({ data: { tiendaId: tiendaB, numero: 1 } })).id;
  // Lo que traiga de pruebas anteriores se saca de en medio: cada prueba arma la fila que necesita.
  await prisma.pedido.updateMany({
    where: { id: { in: pedidoIds } },
    data: { estado: EstadoPedido.CANCELADO, cajeroAsignadoId: null, asignadoAId: null },
  });
  await prisma.usuario.updateMany({
    where: { id: { in: [adminId, cajeroAId] } },
    data: { lastLogin: new Date(), ultimoHeartbeat: new Date() },
  });
});

describe('Ventanilla — el ADMIN la ocupa en la tienda que opera', () => {
  it('elige una de la tienda A aunque no tenga tienda en su cuenta', async () => {
    await ventanillas().elegir(adminId, tiendaA, vA1);
    expect(await dueñoDe(vA1)).toBe(adminId);
  });

  it('una ventanilla que no es de la tienda que opera es 404: la tienda sale de la consola, no de la ventanilla', async () => {
    await expect(ventanillas().elegir(adminId, tiendaA, vB1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await dueñoDe(vB1)).toBeNull();
  });

  it('un CAJERO sigue sin poder elegir la ventanilla de OTRA tienda (la excepción es solo del ADMIN)', async () => {
    await expect(ventanillas().elegir(cajeroAId, tiendaB, vB1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await dueñoDe(vB1)).toBeNull();
  });

  it('cambiar de tienda suelta la anterior: sus pedidos regresan a la fila CONSERVANDO el lugar y la tienda A lo sabe', async () => {
    await ventanillas().elegir(adminId, tiendaA, vA1);
    const p = await pedido(tiendaA, { llegoAHaceMin: 30, cajeroAsignadoId: adminId });
    const lugar = (await leer(p.id)).colaCajaDesdeAt;
    jest.clearAllMocks();

    await ventanillas().elegir(adminId, tiendaB, vB1);

    expect(await dueñoDe(vA1)).toBeNull(); // `cajeroId` es único: sin soltarla, esto reventaba
    expect(await dueñoDe(vB1)).toBe(adminId);
    const despues = await leer(p.id);
    expect(despues.cajeroAsignadoId).toBeNull();
    expect(despues.colaCajaDesdeAt).toEqual(lugar);
    // Avisos a la tienda que se queda sin él (no a la nueva): su TV y su fila se refrescan.
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaA, 'ventanilla.liberada', {
      ventanillaId: vA1,
      numero: 1,
    });
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaA, 'pedido.cajero-liberado', {
      id: p.id,
      numeroPedido: p.numeroPedido,
    });
    const historial = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(historial.at(-1)!.observacion).toMatch(/Regresó a la fila/);
  });

  it('cambiar de ventanilla DENTRO de la misma tienda conserva sus pedidos (siguen siendo suyos)', async () => {
    await ventanillas().elegir(adminId, tiendaA, vA1);
    const p = await pedido(tiendaA, { cajeroAsignadoId: adminId });

    await ventanillas().elegir(adminId, tiendaA, vA2);

    expect(await dueñoDe(vA1)).toBeNull();
    expect(await dueñoDe(vA2)).toBe(adminId);
    expect((await leer(p.id)).cajeroAsignadoId).toBe(adminId);
  });

  it('una ocupada por un cajero: 409 sin confirmar; con confirmar toma el control y le avisa', async () => {
    await ventanillas().elegir(cajeroAId, tiendaA, vA1);

    await expect(ventanillas().elegir(adminId, tiendaA, vA1)).rejects.toMatchObject({
      response: { code: 'VENTANILLA_OCUPADA' },
    });
    expect(await dueñoDe(vA1)).toBe(cajeroAId);

    await ventanillas().elegir(adminId, tiendaA, vA1, true);
    expect(await dueñoDe(vA1)).toBe(adminId);
    expect(realtime.emitToUser).toHaveBeenCalledWith(cajeroAId, 'ventanilla.perdida', {
      numero: 1,
    });
  });

  it('`liberarDelUsuario` la suelta en la tienda que sea y regresa su gente; sin ventanilla no hace nada', async () => {
    expect(await ventanillas().liberarDelUsuario(adminId)).toBeNull();

    await ventanillas().elegir(adminId, tiendaB, vB1);
    const p = await pedido(tiendaB, { cajeroAsignadoId: adminId });

    const r = await ventanillas().liberarDelUsuario(adminId);

    expect(r).toMatchObject({ numero: 1, tiendaId: tiendaB, pedidosRegresadosALaFila: 1 });
    expect(await dueñoDe(vB1)).toBeNull();
    expect((await leer(p.id)).cajeroAsignadoId).toBeNull();
  });
});

describe('Caja — tomar y llamar exigen ventanilla EN LA TIENDA DEL PEDIDO', () => {
  it('con ventanilla en A no puede tomar un pedido de B: 403 y el pedido sigue sin asignar', async () => {
    await ventanillas().elegir(adminId, tiendaA, vA1);
    const enB = await pedido(tiendaB);

    await expect(caja().tomarPedidoCajero(enB.id, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect((await leer(enB.id)).cajeroAsignadoId).toBeNull();
  });

  it('sin ninguna ventanilla tampoco: 403', async () => {
    const enB = await pedido(tiendaB);
    await expect(caja().tomarPedidoCajero(enB.id, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect((await leer(enB.id)).cajeroAsignadoId).toBeNull();
  });

  it('con ventanilla en B toma el de B, y la TV de B lo muestra en SU ventanilla (no en la de A)', async () => {
    await ventanillas().elegir(adminId, tiendaB, vB1);
    const enB = await pedido(tiendaB);

    await caja().tomarPedidoCajero(enB.id, admin);

    expect((await leer(enB.id)).cajeroAsignadoId).toBe(adminId);
    const monitor = new CajeroMonitorService(prisma as never);
    const tvB = await monitor.obtenerMonitorCajero(tiendaB);
    const suVentanilla = tvB.ventanillas.find((v) => v.ventanillaId === vB1)!;
    expect(suVentanilla.cajeroActivo).toBe(true);
    expect(suVentanilla.detallePedidos.map((x) => x.id)).toEqual([enB.id]);
    const tvA = await monitor.obtenerMonitorCajero(tiendaA);
    expect(tvA.ventanillas.flatMap((v) => v.detallePedidos.map((x) => x.id))).not.toContain(enB.id);
  });

  it('"Llamar siguiente" de la tienda B elige de la fila de B aunque en A haya uno más viejo', async () => {
    await ventanillas().elegir(adminId, tiendaB, vB1);
    const viejoEnA = await pedido(tiendaA, { llegoAHaceMin: 90 });
    const enB = await pedido(tiendaB, { llegoAHaceMin: 5 });

    const r = await caja().llamarSiguiente(admin, tiendaB);

    expect(r.pedidoId).toBe(enB.id);
    expect((await leer(enB.id)).cajeroAsignadoId).toBe(adminId);
    expect((await leer(viejoEnA.id)).cajeroAsignadoId).toBeNull();
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaB,
      'pedido.llamado',
      expect.anything(),
    );
    expect(realtime.emitToTienda).not.toHaveBeenCalledWith(
      tiendaA,
      expect.anything(),
      expect.anything(),
    );
  });

  it('con ventanilla solo en A, llamar en B es 400 y no toca a nadie', async () => {
    await ventanillas().elegir(adminId, tiendaA, vA1);
    const enB = await pedido(tiendaB);

    await expect(caja().llamarSiguiente(admin, tiendaB)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect((await leer(enB.id)).cajeroAsignadoId).toBeNull();
  });
});

describe('Bodega — tomarGrupo del ADMIN solo toma de la tienda que opera', () => {
  it('un id de OTRA tienda es 404 y no se toma NADA (con `tiendaId: undefined` Prisma no filtra y tomaba de cualquiera)', async () => {
    const deB = await pedido(tiendaB, { estado: EstadoPedido.SOLICITADO });
    const deA = await pedido(tiendaA, { estado: EstadoPedido.SOLICITADO });

    await expect(bodega().tomarGrupo([deB.id, deA.id], admin, tiendaB)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect((await leer(deB.id)).asignadoAId).toBeNull();
    expect((await leer(deA.id)).asignadoAId).toBeNull();
  });

  it('los de su tienda sí: quedan EN_REVISION asignados al ADMIN y el aviso va a la tienda del pedido', async () => {
    const a = await pedido(tiendaB, { estado: EstadoPedido.SOLICITADO });
    const b = await pedido(tiendaB, { estado: EstadoPedido.SOLICITADO });

    const r = await bodega().tomarGrupo([a.id, b.id], admin, tiendaB);

    expect(r.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    for (const p of [a, b]) {
      const despues = await leer(p.id);
      expect(despues.estado).toBe(EstadoPedido.EN_REVISION);
      expect(despues.asignadoAId).toBe(adminId);
    }
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaB, 'pedido.asignado', {
      id: a.id,
      asignadoAId: adminId,
      asignadoANombre: 'admin (Administrador)',
    });
  });
});
