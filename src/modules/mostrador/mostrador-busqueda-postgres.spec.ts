import 'dotenv/config';
import { PrismaClient, RolUsuario } from '@prisma/client';
import { MostradorQueryService } from './mostrador-query.service';

/**
 * F22: el buscador del mostrador contra PostgreSQL REAL.
 *
 * La coincidencia se calcula con SQL crudo (`translate`, `regexp_replace`, `LIKE`
 * con comodines escapados), y un mock de Prisma no puede decir si ese SQL es válido
 * ni si de verdad encuentra a "José" buscando "jose". Mismo patrón que
 * `sync-postgres.spec.ts`: crea sus propias filas y las borra al terminar.
 */

jest.setTimeout(20_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-8);

let tiendaId: number;
let otraTiendaId: number;
let usuarioId: number;
const ids: Record<string, number> = {};
const folios: Record<string, string> = {};
let consecutivo = 0;

async function crearPedido(
  clave: string,
  datos: {
    nombre: string;
    telefono?: string | null;
    email?: string;
    tienda?: number;
    folioVfp?: string;
  },
) {
  const pedido = await prisma.pedido.create({
    data: {
      // `numero_pedido` es VarChar(20).
      numeroPedido: (folios[clave] = `PD-B${suffix}-${++consecutivo}`),
      usuarioId,
      tiendaId: datos.tienda ?? tiendaId,
      clienteNombre: datos.nombre,
      clienteEmail: datos.email ?? `${clave}-${suffix}@busq.local`,
      clienteTelefono: datos.telefono ?? null,
      subtotal: 100,
      total: 100,
    },
  });
  ids[clave] = pedido.id;
  if (datos.folioVfp) {
    await prisma.pedidoPendienteEnvio.create({
      data: {
        pedidoId: pedido.id,
        estado: 'PENDIENTE',
        externalIdPEDIDOS: 1_000_000_000 + pedido.id,
        externalFolio: datos.folioVfp,
      },
    });
  }
}

const operador = (tienda: number) => ({
  userId: 1,
  nombre: 'Op',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: tienda,
});

let svc: MostradorQueryService;

beforeAll(async () => {
  await prisma.$connect();
  svc = new MostradorQueryService(prisma as never, {} as never);

  const t1 = await prisma.tienda.create({
    data: { nombre: `Busq ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  const t2 = await prisma.tienda.create({
    data: { nombre: `Busq otra ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = t1.id;
  otraTiendaId = t2.id;

  const u = await prisma.usuario.create({
    data: {
      email: `busq-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Busq',
      rol: 'CLIENTE',
    },
  });
  usuarioId = u.id;

  await crearPedido('jose', { nombre: `José Pérez Núñez ${suffix}`, telefono: '55 1234-5678' });
  await crearPedido('maria', { nombre: `María López ${suffix}`, telefono: '(33) 9876 5432' });
  await crearPedido('porcentaje', { nombre: `Descuento 100% ${suffix}` });
  await crearPedido('guion', { nombre: `Ana_Beto ${suffix}` });
  // Señuelo: sin escapar, el `_` de LIKE coincidiría con cualquier carácter y este
  // pedido aparecería al buscar "ana_beto".
  await crearPedido('senuelo', { nombre: `AnaXBeto ${suffix}` });
  await crearPedido('folio', { nombre: `Cliente Folio ${suffix}`, folioVfp: '7734519' });
  await crearPedido('ajeno', {
    nombre: `José Pérez Núñez ${suffix}`,
    telefono: '55 1234-5678',
    tienda: otraTiendaId,
  });
});

afterAll(async () => {
  const todos = Object.values(ids);
  await prisma.pedidoPendienteEnvio.deleteMany({ where: { pedidoId: { in: todos } } });
  await prisma.pedido.deleteMany({ where: { id: { in: todos } } });
  await prisma.usuario.deleteMany({ where: { id: usuarioId } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaId, otraTiendaId] } } });
  await prisma.$disconnect();
});

async function busca(q: string, tienda = tiendaId) {
  const r = await svc.buscarPedidos(q, operador(tienda), tienda);
  return r.data.map((p) => p.id);
}

describe('buscarPedidos contra PostgreSQL real', () => {
  it('ignora acentos: "jose perez" encuentra a "José Pérez"', async () => {
    expect(await busca(`jose perez ${suffix}`)).toEqual([ids.jose]);
  });

  it('ignora acentos también al revés: "José" encuentra "José"', async () => {
    expect(await busca(`José ${suffix}`)).toContain(ids.jose);
  });

  it('encuentra "ñ": "nunez" encuentra "Núñez"', async () => {
    expect(await busca(`nunez ${suffix}`)).toEqual([ids.jose]);
  });

  it('palabras sueltas en cualquier orden: "perez jose"', async () => {
    expect(await busca(`perez jose ${suffix}`)).toEqual([ids.jose]);
  });

  it('TODAS las palabras tienen que aparecer (AND): una que no existe descarta el pedido', async () => {
    expect(await busca(`jose zzzinexistente ${suffix}`)).toEqual([]);
  });

  it('busca por teléfono sin importar el formato que escribe el operador', async () => {
    expect(await busca('5512345678')).toEqual([ids.jose]);
    expect(await busca('55 1234 5678')).toEqual([ids.jose]);
    expect(await busca('55-1234-5678')).toEqual([ids.jose]);
  });

  it('el teléfono guardado con espacios, guiones y paréntesis también coincide', async () => {
    expect(await busca('3398765432')).toEqual([ids.maria]);
    expect(await busca('(33) 9876 5432')).toEqual([ids.maria]);
  });

  it('un fragmento de teléfono de 3+ dígitos coincide', async () => {
    expect(await busca('9876')).toEqual([ids.maria]);
  });

  it('busca por el folio de VFP, el que el cliente trae en el ticket', async () => {
    expect(await busca('7734519')).toEqual([ids.folio]);
  });

  it('busca por folio interno', async () => {
    expect(await busca(folios.jose)).toEqual([ids.jose]);
  });

  it('busca por correo', async () => {
    expect(await busca(`maria-${suffix}@busq.local`)).toEqual([ids.maria]);
  });

  it('el comodín % se busca LITERAL: "100%" no es "cualquier cosa"', async () => {
    // Sin escapar, `%100%%` encontraría cualquier pedido con "100" y un
    // `_` encontraría cualquier carácter.
    expect(await busca(`100% ${suffix}`)).toEqual([ids.porcentaje]);
  });

  it('el comodín _ se busca literal: "ana_beto" no coincide con "AnaXBeto"', async () => {
    expect(await busca(`ana_beto ${suffix}`)).toEqual([ids.guion]);
  });

  it('una comilla o un punto y coma no rompen la consulta (va como parámetro)', async () => {
    await expect(busca("x'; DROP TABLE pedidos; --")).resolves.toEqual([]);
    // Y la tabla sigue ahí.
    expect(await prisma.pedido.count({ where: { id: { in: Object.values(ids) } } })).toBe(7);
  });

  it('NO cruza tiendas: la misma persona en otra tienda no aparece', async () => {
    const enTienda = await busca(`jose perez ${suffix}`, tiendaId);
    const enOtra = await busca(`jose perez ${suffix}`, otraTiendaId);
    expect(enTienda).toEqual([ids.jose]);
    expect(enOtra).toEqual([ids.ajeno]);
  });

  it('ADMIN ve las dos tiendas', async () => {
    const r = await svc.buscarPedidos(
      `jose perez ${suffix}`,
      { userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN },
      undefined,
    );
    expect(r.data.map((p) => p.id).sort()).toEqual([ids.jose, ids.ajeno].sort());
  });
});
