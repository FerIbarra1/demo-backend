import 'dotenv/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, RolUsuario } from '@prisma/client';
import { PedidoAccessService } from './pedido-access.service';

/**
 * Oct 2026 (B2) contra PostgreSQL REAL: buscar un pedido por su folio del Sistema Comercial.
 *
 * El consecutivo del ERP es POR TIENDA, así que el mismo número existe en cada una. Dos tiendas con el MISMO folio
 * ("0000152573") son el caso que importa: el empleado solo debe encontrar el de la suya, y nunca ver (ni confirmar la
 * existencia de) el de la otra.
 */
jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const FOLIO = '0000152573';
let hmo: number;
let mxl: number;
let usuarioId: number;
const pedidoIds: number[] = [];
let n = 0;

const svc = () => new PedidoAccessService(prisma as never);
const empleado = (tiendaId?: number, rol: RolUsuario = RolUsuario.MOSTRADOR) => ({
  userId: 1,
  rol,
  tiendaId,
});

async function pedido(tiendaId: number, extra: Record<string, unknown> = {}) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-FB${suffix}-${++n}`,
      usuarioId,
      tiendaId,
      clienteNombre: 'C',
      clienteEmail: `fb${n}-${suffix}@test.local`,
      subtotal: 1,
      total: 1,
      ...extra,
    },
  });
  pedidoIds.push(p.id);
  return p;
}

let enHmo: { id: number; numeroPedido: string };
let enMxl: { id: number };

beforeAll(async () => {
  const mk = (serie: string) =>
    prisma.tienda.create({
      data: {
        nombre: `Folio ${serie} ${suffix}`,
        direccion: 'x',
        ciudad: 'x',
        estado: 'x',
        serie,
      },
    });
  hmo = (await mk('TSA')).id;
  mxl = (await mk('TSB')).id;
  usuarioId = (
    await prisma.usuario.create({
      data: { email: `fb-${suffix}@test.local`, password: 'x', nombre: 'C', rol: 'CLIENTE' },
    })
  ).id;
  enHmo = await pedido(hmo, { folioErp: FOLIO });
  enMxl = await pedido(mxl, { folioErp: FOLIO });
});

afterAll(async () => {
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({ where: { id: usuarioId } });
  await prisma.tienda.deleteMany({ where: { id: { in: [hmo, mxl] } } });
  await prisma.$disconnect();
});

describe('buscarPorFolio — el folio del Sistema Comercial', () => {
  it.each([FOLIO, '152573', ` ${FOLIO} `])(
    'el empleado de la tienda lo encuentra con "%s"',
    async (texto) => {
      const r = await svc().buscarPorFolio(texto, empleado(hmo));
      expect(r.id).toBe(enHmo.id);
    },
  );

  it('con el MISMO número en dos tiendas, cada empleado encuentra el de SU tienda', async () => {
    expect((await svc().buscarPorFolio(FOLIO, empleado(hmo))).id).toBe(enHmo.id);
    expect((await svc().buscarPorFolio(FOLIO, empleado(mxl))).id).toBe(enMxl.id);
  });

  it('el empleado NO encuentra un folio que solo existe en OTRA tienda (404, sin confirmar que existe)', async () => {
    const soloMxl = '0000777777';
    await pedido(mxl, { folioErp: soloMxl });
    await expect(svc().buscarPorFolio(soloMxl, empleado(hmo))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('la tienda sale del token: escribir la serie de otra tienda no cambia nada para un empleado', async () => {
    const r = await svc().buscarPorFolio(`TSB-${FOLIO}`, empleado(hmo));
    expect(r.id).toBe(enHmo.id);
  });

  it('el ADMIN con el folio solo y en varias tiendas ve la ambigüedad y qué serie escribir', async () => {
    const e = await svc()
      .buscarPorFolio(FOLIO, empleado(undefined, RolUsuario.ADMIN))
      .catch((x) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toMatch(/varias tiendas/);
    expect((e as Error).message).toMatch(/TSA/);
    expect((e as Error).message).toMatch(/TSB/);
  });

  it('el ADMIN con la serie encuentra el de ESA tienda', async () => {
    const admin = empleado(undefined, RolUsuario.ADMIN);
    expect((await svc().buscarPorFolio(`TSA-${FOLIO}`, admin)).id).toBe(enHmo.id);
    expect((await svc().buscarPorFolio(`tsb ${FOLIO}`, admin)).id).toBe(enMxl.id);
  });

  it('el ADMIN con un folio que existe en UNA sola tienda lo encuentra sin serie', async () => {
    const unico = '0000888888';
    const p = await pedido(mxl, { folioErp: unico });
    expect((await svc().buscarPorFolio(unico, empleado(undefined, RolUsuario.ADMIN))).id).toBe(
      p.id,
    );
  });

  it('un empleado SIN tienda no busca por folio: falla cerrado', async () => {
    await expect(svc().buscarPorFolio(FOLIO, empleado(undefined))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('buscarPorFolio — lo de siempre sigue igual', () => {
  it('el número interno (PD-…) se encuentra y respeta el 403 de otra tienda', async () => {
    expect((await svc().buscarPorFolio(enHmo.numeroPedido, empleado(hmo))).id).toBe(enHmo.id);
    await expect(svc().buscarPorFolio(enHmo.numeroPedido, empleado(mxl))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('el folio que guardó la bandeja de envío (legado) se encuentra', async () => {
    const p = await pedido(hmo);
    await prisma.pedidoPendienteEnvio.create({
      data: {
        pedidoId: p.id,
        externalFolio: '0000999999',
        externalIdPEDIDOS: 1_000_000_000 + p.id,
      },
    });
    expect((await svc().buscarPorFolio('0000999999', empleado(hmo))).id).toBe(p.id);
  });

  it('algo que no existe es 404; vacío también', async () => {
    await expect(svc().buscarPorFolio('PD-NO-EXISTE', empleado(hmo))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc().buscarPorFolio('   ', empleado(hmo))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
