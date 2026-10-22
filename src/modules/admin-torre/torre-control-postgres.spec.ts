import 'dotenv/config';
import {
  EstadoPagoTransferencia,
  EstadoPedido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { TorreControlService } from './torre-control.service';

/**
 * N1 (oct 2026) contra PostgreSQL REAL: la torre de control cuenta y mide la ESPERA por tienda con pocas consultas
 * para todas a la vez. Se arman dos tiendas activas (una con de todo, otra vacía) y una INACTIVA con pedidos que no
 * debe salir. Lo que se fija: qué estados entran en cada número, desde CUÁNDO se mide cada espera, qué NO cuenta como
 * espera del personal (el cliente que no está, domicilio) y el semáforo resultante.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const hace = (min: number) => new Date(Date.now() - min * 60_000);

let tiendaA: number;
let tiendaB: number;
let tiendaInactiva: number;
let clienteId: number;
let bodegueroId: number;
let cajeroId: number;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let n = 0;
let ref = 0;

const impresion = {
  resumen: jest.fn(async () => ({
    tabs: { revisar: 2, correccion: 1, imprimir: 3, imprimiendo: 1, listos: 4 },
    hoy: { metrosTextil: 7, metrosUv: 5.5, metros: 12.5, trabajos: 6 },
  })),
};
const svc = () =>
  new TorreControlService(prisma as never, { get: () => 4 } as never, impresion as never);
const admin = { userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN, tiendaId: undefined };

async function pedido(
  tiendaId: number,
  estado: EstadoPedido,
  o: Partial<Parameters<typeof prisma.pedido.create>[0]['data']> & { historialHace?: number } = {},
) {
  const { historialHace, ...resto } = o;
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-T${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'C',
      clienteEmail: `t${n}-${suffix}@test.local`,
      subtotal: 1,
      total: 1,
      fechaPedido: hace(300),
      ...resto,
    } as never,
  });
  pedidoIds.push(p.id);
  if (historialHace !== undefined) {
    await prisma.historialPedido.create({
      data: {
        pedidoId: p.id,
        estadoAnterior: null,
        estadoNuevo: estado,
        createdAt: hace(historialHace),
      },
    });
  }
  return p;
}

async function transferencia(
  pedidoId: number,
  estado: EstadoPagoTransferencia,
  o: { updatedHace?: number; verificadaHace?: number } = {},
) {
  await prisma.pedidoPagoTransferencia.create({
    data: {
      pedidoId,
      estado,
      montoEsperado: 100,
      cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
      referencia: String(7_100_000 + ++ref + Number(suffix.slice(-3)) * 1000).slice(0, 7),
      concepto: 'PRUEBA',
      ...(estado === EstadoPagoTransferencia.APLICADO ? { aplicadoAt: hace(1) } : {}),
      ...(o.updatedHace !== undefined ? { updatedAt: hace(o.updatedHace) } : {}),
      ...(o.verificadaHace !== undefined
        ? { verificadoAt: hace(o.verificadaHace), montoVerificado: 100, verificadoPorId: cajeroId }
        : {}),
    },
  });
}

async function usuario(nombre: string, rol: RolUsuario) {
  const u = await prisma.usuario.create({
    data: { email: `${nombre}-t-${suffix}@test.local`, password: 'x', nombre, rol },
  });
  usuarioIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  const mk = (nombre: string, activa: boolean) =>
    prisma.tienda.create({
      data: {
        nombre: `Torre ${nombre} ${suffix}`,
        direccion: 'x',
        ciudad: `Ciudad ${nombre}`,
        estado: 'x',
        activa,
      },
    });
  tiendaA = (await mk('A', true)).id;
  tiendaB = (await mk('B', true)).id;
  tiendaInactiva = (await mk('Z', false)).id;
  clienteId = await usuario('cli', RolUsuario.CLIENTE);
  bodegueroId = await usuario('bod', RolUsuario.BODEGA);
  cajeroId = await usuario('caj', RolUsuario.CAJERO);

  // ── Tienda A: de todo ─────────────────────────────────────────
  await pedido(tiendaA, EstadoPedido.SOLICITADO, { fechaPedido: hace(40) }); // bodega, 40 min
  await pedido(tiendaA, EstadoPedido.EN_REVISION, {
    asignadoAId: bodegueroId,
    asignadoAt: hace(10),
  }); // surtiendo
  await pedido(tiendaA, EstadoPedido.EN_REVISION, { historialHace: 20 }); // liberado: libre desde hace 20 (NO 300)
  await pedido(tiendaA, EstadoPedido.EN_ASESORIA, { historialHace: 25 });
  await pedido(tiendaA, EstadoPedido.ESPERANDO_APROBACION);
  await pedido(tiendaA, EstadoPedido.REVISADO, { presenteDesdeAt: hace(12) }); // cliente EN tienda esperando
  await pedido(tiendaA, EstadoPedido.REVISADO); // el cliente NO está: espera al cliente, no al personal
  await pedido(tiendaA, EstadoPedido.EN_ATENCION, { presenteDesdeAt: hace(30) });
  await pedido(tiendaA, EstadoPedido.EN_DTF);
  await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, { colaCajaDesdeAt: hace(5) }); // fila
  await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
    colaCajaDesdeAt: hace(200),
    cajeroAsignadoId: cajeroId,
    cajeroAsignadoAt: new Date(),
  }); // atendiéndose: ya no espera
  await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, {
    modoEntrega: ModoEntrega.DOMICILIO,
    colaCajaDesdeAt: hace(500),
  }); // no es de caja
  await pedido(tiendaA, EstadoPedido.PAGADO);
  await pedido(tiendaA, EstadoPedido.PAGADO);
  await pedido(tiendaA, EstadoPedido.ENVIADO);
  await pedido(tiendaA, EstadoPedido.ENTREGADO); // terminal: no cuenta
  await pedido(tiendaA, EstadoPedido.CANCELADO);
  const pt1 = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, { colaCajaDesdeAt: hace(1) });
  await transferencia(pt1.id, EstadoPagoTransferencia.EN_REVISION, { updatedHace: 90 });
  const pt2 = await pedido(tiendaA, EstadoPedido.PENDIENTE_PAGO, { colaCajaDesdeAt: hace(2) });
  await transferencia(pt2.id, EstadoPagoTransferencia.VERIFICADO, { verificadaHace: 300 });
  const pt3 = await pedido(tiendaA, EstadoPedido.PAGADO);
  await transferencia(pt3.id, EstadoPagoTransferencia.APLICADO, { verificadaHace: 600 }); // ya registrada: no cuenta

  // ── Tienda INACTIVA: no debe salir ────────────────────────────
  await pedido(tiendaInactiva, EstadoPedido.SOLICITADO, { fechaPedido: hace(999) });
});

afterAll(async () => {
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB, tiendaInactiva] } } });
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

const deLa = async (id: number) => {
  // +5 s: los pedidos de prueba se crean DESPUÉS de cargar el módulo, y una espera de "40 min" medida un instante antes daría 39.
  const r = await svc().obtener(admin as never, new Date(Date.now() + 5_000));
  return { r, t: r.tiendas.find((x) => x.tienda.id === id) };
};

describe('Torre de control — por tienda, con pocas consultas', () => {
  it('lista las tiendas ACTIVAS (la inactiva no sale) con su ciudad', async () => {
    const { r, t } = await deLa(tiendaA);
    expect(r.tiendas.some((x) => x.tienda.id === tiendaInactiva)).toBe(false);
    expect(t!.tienda).toEqual({
      id: tiendaA,
      nombre: expect.stringContaining('Torre A'),
      ciudad: 'Ciudad A',
    });
    expect(Date.parse(r.generadoAt)).not.toBeNaN();
  });

  it('cuenta cada etapa con los estados que le tocan', async () => {
    const { t } = await deLa(tiendaA);
    expect(t!.etapas).toEqual({
      bodega: { enCola: 2, surtiendo: 1 }, // SOLICITADO + EN_REVISION libre / EN_REVISION con bodeguero
      ventas: { enAsesoria: 1, esperandoCliente: 1 },
      mostrador: { enArea: 2, esperandoEnTienda: 1, atendiendo: 1 },
      dtf: { enDtf: 1 },
      // En fila: la de hace 5 min y las dos con transferencia. El asignado es "atendiendo"; el domicilio NO es de caja.
      caja: { enFila: 3, atendiendo: 1 },
      porEntregar: { pagados: 3, enviados: 1 },
    });
  });

  it('transferencias: por verificar (EN_REVISION) y verificadas sin registrar (VERIFICADO); las APLICADAS no cuentan', async () => {
    const { t } = await deLa(tiendaA);
    expect(t!.transferencias).toEqual({ porVerificar: 1, sinRegistrar: 1 });
  });

  it('el DTF sale de `ImpresionService.resumen` (el mismo número que la consola de Impresión)', async () => {
    const { t } = await deLa(tiendaA);
    expect(t!.dtf).toEqual({
      porRevisar: 2,
      correccion: 1,
      imprimir: 3,
      imprimiendo: 1,
      listos: 4,
      metrosHoy: 12.5,
    });
    expect(impresion.resumen).toHaveBeenCalledWith(admin, tiendaA);
  });

  it('una tienda sin nada: todo en cero, verde y sin "más viejo"', async () => {
    const { t } = await deLa(tiendaB);
    expect(t!.semaforo).toEqual({ nivel: 'verde', motivos: [] });
    expect(t!.masViejo).toBeNull();
    expect(t!.etapas.bodega).toEqual({ enCola: 0, surtiendo: 0 });
    expect(t!.etapas.caja).toEqual({ enFila: 0, atendiendo: 0 });
    expect(t!.transferencias).toEqual({ porVerificar: 0, sinRegistrar: 0 });
  });
});

describe('Torre de control — la ESPERA y el semáforo', () => {
  it('cada espera se mide desde su momento correcto', async () => {
    const { t } = await deLa(tiendaA);
    const m = Object.fromEntries(t!.semaforo.motivos.map((x) => [x.etapa, x.minutos]));
    // bodega: el SOLICITADO de hace 40 min manda; el liberado cuenta desde que quedó libre (20), no desde que se hizo (300).
    expect(m.bodega).toBe(40);
    // mostrador: desde que el cliente llegó (12), no el REVISADO sin cliente ni el EN_ATENCION.
    expect(m.mostrador).toBe(12);
    // ventas: desde que entró a asesoría (25) → ámbar? (umbral 30) no: verde, no aparece.
    expect(m.ventas).toBeUndefined();
    // transferencia por verificar desde su última actualización (90), y verificada sin registrar desde hace 300 min.
    expect(m.transferencias).toBe(90);
    expect(m.sinRegistrar).toBe(300);
    // caja: el de la fila más antiguo es el de hace 5 min → verde; el asignado (200) y el domicilio (500) NO cuentan.
    expect(m.caja).toBeUndefined();
  });

  it('la tienda queda ROJA por la peor etapa y lista sus motivos del peor al menos malo', async () => {
    const { t } = await deLa(tiendaA);
    expect(t!.semaforo.nivel).toBe('rojo'); // bodega 40 min ≥ 30
    // Del peor nivel al menos malo; a igual nivel, el que más espera primero (300, 90 y 12 min).
    expect(t!.semaforo.motivos.map((x) => [x.etapa, x.nivel])).toEqual([
      ['bodega', 'rojo'],
      ['sinRegistrar', 'ambar'],
      ['transferencias', 'ambar'],
      ['mostrador', 'ambar'],
    ]);
    expect(t!.semaforo.motivos[0].texto).toMatch(/^Bodega \(sin tomar\): 40 min esperando \(PD-T/);
  });

  it('"lo que más espera" es la mayor de todas (aquí, la transferencia sin registrar: 300 min)', async () => {
    const { t } = await deLa(tiendaA);
    expect(t!.masViejo).toEqual({
      etapa: 'sinRegistrar',
      minutos: 300,
      referencia: expect.stringContaining('PD-T'),
    });
  });
});

describe('Torre de control — acotada a UNA tienda (la del GERENTE)', () => {
  const gerente = (tiendaId: number) => ({
    userId: 9,
    nombre: 'Gerente',
    rol: RolUsuario.GERENTE,
    tiendaId,
  });
  const ahora = () => new Date(Date.now() + 5_000);

  it('trae SOLO esa tienda, con exactamente los mismos números que su tarjeta en la torre del ADMIN', async () => {
    const todas = await svc().obtener(admin as never, ahora());
    const soloA = await svc().obtener(gerente(tiendaA) as never, ahora(), tiendaA);
    expect(soloA.tiendas.map((x) => x.tienda.id)).toEqual([tiendaA]);
    expect(soloA.tiendas[0]).toEqual(todas.tiendas.find((x) => x.tienda.id === tiendaA));

    const soloB = await svc().obtener(gerente(tiendaB) as never, ahora(), tiendaB);
    expect(soloB.tiendas.map((x) => x.tienda.id)).toEqual([tiendaB]);
    // Lo que pasa en A (pedidos, transferencias) no se cuela en la tarjeta de B.
    expect(soloB.tiendas[0].etapas.bodega).toEqual({ enCola: 0, surtiendo: 0 });
    expect(soloB.tiendas[0].transferencias).toEqual({ porVerificar: 0, sinRegistrar: 0 });
  });

  it('el DTF de su tarjeta se pide a Impresión CON su propio contexto, solo para su tienda', async () => {
    impresion.resumen.mockClear();
    const g = gerente(tiendaA);
    await svc().obtener(g as never, ahora(), tiendaA);
    expect(impresion.resumen).toHaveBeenCalledTimes(1);
    expect(impresion.resumen).toHaveBeenCalledWith(g, tiendaA);
  });

  it('una tienda inactiva no sale ni acotando a ella', async () => {
    const r = await svc().obtener(gerente(tiendaInactiva) as never, ahora(), tiendaInactiva);
    expect(r.tiendas).toEqual([]);
  });
});
