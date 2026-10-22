import 'dotenv/config';
import { ForbiddenException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { MostradorQueryService } from '../../mostrador/mostrador-query.service';

/**
 * N2 (oct 2026) contra PostgreSQL REAL: la búsqueda GLOBAL del ADMIN (sin tienda) encuentra pedidos de VARIAS
 * tiendas y cada fila trae su `tienda` (lo que la pantalla pinta); la del empleado sigue acotada a la suya y falla
 * cerrado sin tienda. El filtro de tienda vive en un SQL crudo (`idsQueCoinciden`) Y en el `where` de Prisma: un mock
 * no vería si una de las dos capas dejara de filtrar.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const UNICO = `Zq${suffix}`; // texto que solo existe en estos pedidos
let tiendaA: number;
let tiendaB: number;
let clienteId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];

const svc = () => new MostradorQueryService(prisma as never, {} as never);
const admin = { userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN, tiendaId: undefined };
const empleadoDeA = () => ({
  userId: 2,
  nombre: 'Emp',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: tiendaA,
});

async function pedido(tiendaId: number, estado: EstadoPedido, n: number) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-G${suffix}-${n}`,
      usuarioId: clienteId,
      tiendaId,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: `${UNICO} Cliente ${n}`,
      clienteEmail: `g${n}-${suffix}@test.local`,
      subtotal: 1,
      total: 1,
    },
  });
  pedidoIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const mk = (n: string) =>
    prisma.tienda.create({
      data: { nombre: `Global ${n} ${suffix}`, direccion: 'x', ciudad: `Ciudad ${n}`, estado: 'x' },
    });
  tiendaA = (await mk('A')).id;
  tiendaB = (await mk('B')).id;
  const c = await prisma.usuario.create({
    data: {
      email: `cli-g-${suffix}@test.local`,
      password: 'x',
      nombre: 'Cli',
      rol: RolUsuario.CLIENTE,
    },
  });
  clienteId = c.id;
  usuarioIds.push(c.id);
  await pedido(tiendaA, EstadoPedido.REVISADO, 1);
  await pedido(tiendaB, EstadoPedido.ENTREGADO, 2); // terminal: la búsqueda global también los encuentra
  await pedido(tiendaB, EstadoPedido.PENDIENTE_PAGO, 3);
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB] } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

describe('Búsqueda global (ADMIN, sin tienda)', () => {
  it('encuentra pedidos de TODAS las tiendas, en cualquier estado', async () => {
    const r = await svc().buscarPedidos(UNICO, admin as never, undefined);
    expect(r.meta.total).toBe(3);
    expect(r.data.map((p) => p.tiendaId).sort()).toEqual([tiendaA, tiendaB, tiendaB].sort());
    expect(r.data.map((p) => p.estado)).toEqual(
      expect.arrayContaining(['REVISADO', 'ENTREGADO', 'PENDIENTE_PAGO']),
    );
  });

  it('cada fila trae SU tienda (id, nombre y ciudad): es lo que la pantalla pinta', async () => {
    const r = await svc().buscarPedidos(UNICO, admin as never, undefined);
    for (const p of r.data) {
      expect(p.tienda).toEqual(
        expect.objectContaining({
          id: p.tiendaId,
          nombre: expect.any(String),
          ciudad: expect.any(String),
        }),
      );
    }
    const deA = r.data.find((p) => p.tiendaId === tiendaA)!;
    expect(deA.tienda.ciudad).toBe('Ciudad A');
  });

  it('por folio interno encuentra el pedido sin saber la tienda', async () => {
    const r = await svc().buscarPedidos(`PD-G${suffix}-2`, admin as never, undefined);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].tiendaId).toBe(tiendaB);
  });

  it('pagina', async () => {
    const r = await svc().buscarPedidos(UNICO, admin as never, undefined, 2, 2);
    expect(r.data).toHaveLength(1);
    expect(r.meta).toEqual(
      expect.objectContaining({ total: 3, pagina: 2, limite: 2, totalPaginas: 2 }),
    );
  });
});

describe('La del empleado NO cambia', () => {
  it('con SU tienda solo ve la suya', async () => {
    const e = empleadoDeA();
    const r = await svc().buscarPedidos(UNICO, e as never, e.tiendaId);
    expect(r.data.map((p) => p.tiendaId)).toEqual([tiendaA]);
  });

  it('sin tienda falla cerrado (no cae en la búsqueda global)', async () => {
    const e = { ...empleadoDeA(), tiendaId: undefined };
    await expect(svc().buscarPedidos(UNICO, e as never, undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el ADMIN que ELIGE una tienda sigue acotado a ella (consola de una tienda)', async () => {
    const r = await svc().buscarPedidos(UNICO, admin as never, tiendaB);
    expect(r.data.every((p) => p.tiendaId === tiendaB)).toBe(true);
    expect(r.meta.total).toBe(2);
  });
});
