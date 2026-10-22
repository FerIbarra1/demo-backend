import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Oct 2026 contra PostgreSQL REAL — dos defectos que solo aparecieron al sincronizar el Firebird real (que es el que manda):
 *  - el SKU de la variante se repite en cada tienda del ERP (1 025 SKUs en 7 733 filas, ninguno repetido DENTRO de una tienda),
 *    pero `precios_co.sku` era único en toda la nube: solo la primera tienda guardaba el precio de una variante;
 *  - `COLORES.DESCRIP` mide 40 en Firebird y el color de la nube 30.
 */
jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
let t1: number;
let t2: number;
let producto: number;
let corrida: number;
let talla: number;
let color: number;
let n = 0;

const pco = (tiendaId: number, sku: string | null) => {
  n++;
  return prisma.precioCO.create({
    data: {
      productoId: producto,
      tiendaId,
      corridaId: corrida,
      // Una variante distinta por fila: la llave natural también es única.
      tallaId: talla,
      colorId: color,
      precio: 1,
      lista1: 1,
      ...(sku !== undefined ? { sku } : {}),
    },
  });
};

beforeAll(async () => {
  const mk = (x: string) =>
    prisma.tienda.create({
      data: { nombre: `Sku ${x} ${suffix}`, direccion: 'x', ciudad: x, estado: 'x' },
    });
  t1 = (await mk('A')).id;
  t2 = (await mk('B')).id;
  producto = (await prisma.producto.create({ data: { codigo: `SKU-${suffix}`, nombre: 'P' } })).id;
  corrida = (await prisma.corrida.create({ data: { nombre: `C${suffix}` } })).id;
  talla = (await prisma.talla.create({ data: { corridaId: corrida, nombre: 'M' } })).id;
  color = (
    await prisma.color.create({
      data: { codigo: `K${suffix}`.slice(0, 10), nombre: 'FS/ NEGRO FC/ GRIS OBS JAS V/M NEGRO' },
    })
  ).id;
});

afterAll(async () => {
  await prisma.precioCO.deleteMany({ where: { tiendaId: { in: [t1, t2] } } });
  await prisma.color.deleteMany({ where: { id: color } });
  await prisma.talla.deleteMany({ where: { id: talla } });
  await prisma.corrida.deleteMany({ where: { id: corrida } });
  await prisma.producto.deleteMany({ where: { id: producto } });
  await prisma.tienda.deleteMany({ where: { id: { in: [t1, t2] } } });
  await prisma.$disconnect();
});

describe('SKU de la variante: único por tienda, no global', () => {
  it('el MISMO SKU en dos tiendas se guarda en las dos (como lo tiene el ERP)', async () => {
    await pco(t1, `B0300-${suffix}`);
    await expect(pco(t2, `B0300-${suffix}`)).resolves.toMatchObject({ tiendaId: t2 });
  });

  it('dentro de UNA tienda un SKU repetido sigue siendo error (el ERP no lo permite y aquí tampoco)', async () => {
    // Otra variante (otra talla) con el SKU ya usado en la misma tienda.
    const otraTalla = await prisma.talla.create({ data: { corridaId: corrida, nombre: 'L' } });
    await expect(
      prisma.precioCO.create({
        data: {
          productoId: producto,
          tiendaId: t1,
          corridaId: corrida,
          tallaId: otraTalla.id,
          colorId: color,
          precio: 1,
          lista1: 1,
          sku: `B0300-${suffix}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('las variantes SIN SKU no chocan entre sí', async () => {
    const t3 = await prisma.talla.create({ data: { corridaId: corrida, nombre: 'XL' } });
    const t4 = await prisma.talla.create({ data: { corridaId: corrida, nombre: '2XL' } });
    for (const tallaId of [t3.id, t4.id]) {
      await expect(
        prisma.precioCO.create({
          data: {
            productoId: producto,
            tiendaId: t2,
            corridaId: corrida,
            tallaId,
            colorId: color,
            precio: 1,
            lista1: 1,
            sku: null,
          },
        }),
      ).resolves.toBeTruthy();
    }
  });
});

describe('Nombre del color: el ancho de Firebird (40)', () => {
  it('un color de 40 caracteres se guarda completo, y el snapshot de la línea del pedido también', async () => {
    const nombre = 'F/ GRIS CLARO JAS V/ AMA TRIGO M/ ARENAS'.slice(0, 40);
    expect(nombre).toHaveLength(40);
    const c = await prisma.color.create({ data: { codigo: `L${suffix}`.slice(0, 10), nombre } });
    try {
      expect((await prisma.color.findUniqueOrThrow({ where: { id: c.id } })).nombre).toBe(nombre);
      const cliente = await prisma.usuario.create({
        data: { email: `sku-${suffix}@test.local`, password: 'x', nombre: 'C', rol: 'CLIENTE' },
      });
      const p = await prisma.pedido.create({
        data: {
          numeroPedido: `PD-SK${suffix}`,
          usuarioId: cliente.id,
          tiendaId: t1,
          clienteNombre: 'C',
          clienteEmail: cliente.email,
          subtotal: 1,
          total: 1,
          items: {
            create: {
              productoId: producto,
              cantidad: 1,
              precioUnitario: 1,
              subtotal: 1,
              productoNombre: 'P',
              productoCodigo: 'P',
              corridaNombre: 'C',
              tallaNombre: 'M',
              colorNombre: nombre,
            },
          },
        },
        include: { items: true },
      });
      expect(p.items[0].colorNombre).toBe(nombre);
      await prisma.pedido.delete({ where: { id: p.id } });
      await prisma.usuario.delete({ where: { id: cliente.id } });
    } finally {
      await prisma.color.delete({ where: { id: c.id } });
    }
  });
});
