import 'dotenv/config';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  EstadoPagoTransferencia as E,
  EstadoPedido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { CajeroService } from './cajero.service';
import { CajeroMonitorService } from './cajero-monitor.service';
import { VentanillasService } from '../../ventanillas/ventanillas.service';

/**
 * Oct 2026: LA fila de caja contra PostgreSQL REAL — el orden de turno, las transferencias, "no se
 * presentó" y soltar la ventanilla. La consola, "Llamar siguiente" y la TV tienen que decir lo
 * mismo, y eso depende de qué hacen los `where` y los `updateMany` de verdad.
 */

jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };

let tiendaId: number;
let clienteId: number;
let cajero: { userId: number; nombre: string; rol: RolUsuario; tiendaId: number };
let otroCajero: typeof cajero;
const pedidoIds: number[] = [];
const usuarioIds: number[] = [];
let consecutivo = 0;
let refs = 0;

const min = (n: number) => new Date(Date.now() - n * 60_000);

function servicios() {
  const ventanillas = new VentanillasService(prisma as never, realtime as never);
  const caja = new CajeroService(prisma as never, realtime as never, {} as never, ventanillas);
  const monitor = new CajeroMonitorService(prisma as never);
  return { caja, monitor, ventanillas };
}

/**
 * `llegoAHaceMin`: hace cuántos minutos llegó a la fila de caja. `pedidoHaceMin`: hace cuántos se
 * HIZO el pedido (para demostrar que ya no manda).
 */
async function crearPedido(
  o: {
    llegoAHaceMin?: number;
    pedidoHaceMin?: number;
    modo?: ModoEntrega;
    transferencia?: { estado: E; verificadaHaceMin?: number };
  } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-F${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado: EstadoPedido.PENDIENTE_PAGO,
      modoEntrega: o.modo ?? ModoEntrega.RECOGER_TIENDA,
      fechaPedido: min(o.pedidoHaceMin ?? o.llegoAHaceMin ?? 0),
      colaCajaDesdeAt: min(o.llegoAHaceMin ?? 0),
      clienteNombre: 'Cliente Test',
      clienteEmail: `fila-${suffix}@test.local`,
      subtotal: 100,
      total: 100,
    },
  });
  pedidoIds.push(p.id);
  if (o.transferencia) {
    await prisma.pedidoPagoTransferencia.create({
      data: {
        pedidoId: p.id,
        estado: o.transferencia.estado,
        montoEsperado: 100,
        cuentaSnapshot: { banco: 'B', titular: 'T', clabe: '012180001234567897' },
        referencia: String(7_000_000 + ++refs + Number(suffix.slice(-3)) * 1000).slice(0, 7),
        concepto: 'PRUEBA',
        venceAt: new Date(Date.now() + 3_600_000),
        // La BD exige que todo pago verificado diga cuánto, cuándo y quién.
        ...(o.transferencia.verificadaHaceMin !== undefined
          ? {
              verificadoAt: min(o.transferencia.verificadaHaceMin),
              montoVerificado: 100,
              verificadoPorId: cajero.userId,
            }
          : {}),
      },
    });
  }
  return p;
}

async function crearCajero(n: number) {
  const u = await prisma.usuario.create({
    data: {
      email: `fila-cajero${n}-${suffix}@test.local`,
      password: 'solo-para-pruebas',
      nombre: `Cajero ${n}`,
      rol: RolUsuario.CAJERO,
      tiendaId,
      // La TV solo muestra a un cajero "activo" (con sesión o latido recientes).
      lastLogin: new Date(),
    },
  });
  usuarioIds.push(u.id);
  return { userId: u.id, nombre: u.nombre, rol: RolUsuario.CAJERO, tiendaId };
}

const folios = (xs: Array<{ numeroPedido: string }>) => xs.map((x) => x.numeroPedido);

beforeAll(async () => {
  await prisma.$connect();
  const tienda = await prisma.tienda.create({
    data: { nombre: `Fila test ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;
  const c = await prisma.usuario.create({
    data: {
      email: `fila-cliente-${suffix}@test.local`,
      password: 'solo-para-pruebas',
      nombre: 'Cliente',
      rol: RolUsuario.CLIENTE,
    },
  });
  clienteId = c.id;
  usuarioIds.push(c.id);
  cajero = await crearCajero(1);
  otroCajero = await crearCajero(2);
  await prisma.ventanilla.create({ data: { tiendaId, numero: 1, cajeroId: cajero.userId } });
});

afterAll(async () => {
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } }); // ventanillas en cascada
  await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await prisma.pedidoPagoTransferencia.deleteMany({ where: { pedido: { tiendaId } } });
  await prisma.pedido.updateMany({
    where: { tiendaId, estado: EstadoPedido.PENDIENTE_PAGO },
    data: { estado: EstadoPedido.CANCELADO, cajeroAsignadoId: null },
  });
  // Cada prueba empieza con el cajero 1 en su ventanilla.
  await prisma.ventanilla.updateMany({
    where: { tiendaId, numero: 1 },
    data: { cajeroId: cajero.userId },
  });
});

describe('Fila de caja — el turno es de cuándo llegó a CAJA', () => {
  it('"Llamar siguiente" toma al que llegó antes a caja, aunque su pedido sea más reciente', async () => {
    const { caja } = servicios();
    // Pedido web hecho hace 3 h que mostrador mandó a pagar hace 5 min…
    await crearPedido({ pedidoHaceMin: 180, llegoAHaceMin: 5 });
    // …y un kiosko hecho hace 30 min que llegó a caja hace 20.
    const kiosko = await crearPedido({ pedidoHaceMin: 30, llegoAHaceMin: 20 });

    const r = await caja.llamarSiguiente(cajero as never);
    expect(r.pedidoId).toBe(kiosko.id);
  });

  it('la consola y la TV listan la fila en ESE mismo orden', async () => {
    const { caja, monitor } = servicios();
    const web = await crearPedido({ pedidoHaceMin: 180, llegoAHaceMin: 5 });
    const kiosko = await crearPedido({ pedidoHaceMin: 30, llegoAHaceMin: 20 });

    const consola = await caja.obtenerColaVentanilla(tiendaId);
    const tv = await monitor.obtenerMonitorCajero(tiendaId);
    expect(consola.data.map((p) => p.id)).toEqual([kiosko.id, web.id]);
    expect(tv.colaSinAsignar.map((p) => p.id)).toEqual([kiosko.id, web.id]);
  });

  it('los domicilio no están en la fila', async () => {
    const { caja } = servicios();
    await crearPedido({ modo: ModoEntrega.DOMICILIO });
    const normal = await crearPedido();
    const cola = await caja.obtenerColaVentanilla(tiendaId);
    expect(cola.data.map((p) => p.id)).toEqual([normal.id]);
  });

  it('la consola informa cuánto lleva en la fila de caja, no desde que se hizo el pedido', async () => {
    const { caja } = servicios();
    await crearPedido({ pedidoHaceMin: 600, llegoAHaceMin: 7 });
    const [fila] = (await caja.obtenerColaVentanilla(tiendaId)).data;
    expect(fila.minutosEnCola).toBeGreaterThanOrEqual(6);
    expect(fila.minutosEnCola).toBeLessThan(10);
  });
});

describe('Fila de caja — transferencias', () => {
  it('una transferencia en proceso entra EN SU LUGAR de llegada: consola, TV y "Llamar siguiente" coinciden', async () => {
    const { caja, monitor } = servicios();
    const enProceso = await crearPedido({
      llegoAHaceMin: 30,
      transferencia: { estado: E.PENDIENTE },
    });
    const enRevision = await crearPedido({
      llegoAHaceMin: 25,
      transferencia: { estado: E.EN_REVISION },
    });
    const efectivo = await crearPedido({ llegoAHaceMin: 5 });

    // 16-oct: antes iban al final y "Llamar siguiente" las saltaba. Ahora todos por llegada: el
    // cliente puede necesitar ayuda para transferir, y no se le pasa por encima.
    const consola = await caja.obtenerColaVentanilla(tiendaId);
    expect(consola.data.map((p) => p.id)).toEqual([enProceso.id, enRevision.id, efectivo.id]);

    // La TV las muestra DE INMEDIATO, en el mismo orden y sin ningún distintivo: es pública.
    const tv = await monitor.obtenerMonitorCajero(tiendaId);
    expect(tv.colaSinAsignar.map((p) => p.id)).toEqual(consola.data.map((p) => p.id));
    expect(tv.contadores.colaSinAsignar).toBe(3);
    expect(Object.keys(tv.colaSinAsignar[0]).sort()).toEqual(
      Object.keys(tv.colaSinAsignar[2]).sort(),
    );

    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(enProceso.id);
  });

  it('con SOLO transferencias en proceso también hay turno que llamar', async () => {
    const { caja, monitor } = servicios();
    const p = await crearPedido({ transferencia: { estado: E.PENDIENTE } });
    expect((await monitor.obtenerMonitorCajero(tiendaId)).colaSinAsignar.map((x) => x.id)).toEqual([
      p.id,
    ]);
    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(p.id);
  });

  it('un pedido a DOMICILIO nunca aparece en la TV, pague como pague', async () => {
    const { monitor } = servicios();
    await crearPedido({ modo: ModoEntrega.DOMICILIO, transferencia: { estado: E.PENDIENTE } });
    expect((await monitor.obtenerMonitorCajero(tiendaId)).colaSinAsignar).toHaveLength(0);
  });

  it('una transferencia VERIFICADA NO pasa adelante: orden de llegada en consola, TV y "Llamar siguiente"', async () => {
    const { caja, monitor } = servicios();
    const efectivo = await crearPedido({ llegoAHaceMin: 40 });
    const verificada = await crearPedido({
      llegoAHaceMin: 10,
      transferencia: { estado: E.VERIFICADO, verificadaHaceMin: 2 },
    });

    // 16-oct: antes la verificada se atendía primero. Ahora todos por llegada, con la misma importancia.
    expect((await caja.obtenerColaVentanilla(tiendaId)).data.map((p) => p.id)).toEqual([
      efectivo.id,
      verificada.id,
    ]);
    expect((await monitor.obtenerMonitorCajero(tiendaId)).colaSinAsignar.map((p) => p.id)).toEqual([
      efectivo.id,
      verificada.id,
    ]);
    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(efectivo.id);
  });

  it('la paginación respeta el orden de turno, no el de la base', async () => {
    const { caja } = servicios();
    const a = await crearPedido({ llegoAHaceMin: 30 });
    const b = await crearPedido({ llegoAHaceMin: 20 });
    const v = await crearPedido({
      llegoAHaceMin: 5,
      transferencia: { estado: E.VERIFICADO, verificadaHaceMin: 1 },
    });
    // Se insertaron en otro orden que el de llegada para probar que no manda el de la base.
    const p1 = await caja.obtenerColaVentanilla(tiendaId, 1, 2);
    const p2 = await caja.obtenerColaVentanilla(tiendaId, 2, 2);
    expect(p1.data.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(p2.data.map((p) => p.id)).toEqual([v.id]);
    expect(p1.meta).toMatchObject({ total: 3, totalPaginas: 2 });
  });
});

describe('Fila de caja — "Devolver a la cola" vs "No se presentó"', () => {
  it('devolver a la cola CONSERVA el lugar', async () => {
    const { caja } = servicios();
    const primero = await crearPedido({ llegoAHaceMin: 30 });
    const segundo = await crearPedido({ llegoAHaceMin: 10 });

    await caja.llamarSiguiente(cajero as never); // toma al primero
    await caja.liberarPedidoCajero(primero.id, cajero as never);

    expect((await caja.obtenerColaVentanilla(tiendaId)).data.map((p) => p.id)).toEqual([
      primero.id,
      segundo.id,
    ]);
  });

  it('"No se presentó" lo manda al FINAL y "Llamar siguiente" ya no lo repite', async () => {
    const { caja, monitor } = servicios();
    const ausente = await crearPedido({ llegoAHaceMin: 30 });
    const esperando = await crearPedido({ llegoAHaceMin: 10 });

    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(ausente.id);
    await caja.noSePresento(ausente.id, cajero as never);

    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: ausente.id } });
    expect(despues.cajeroAsignadoId).toBeNull();
    expect(despues.cajeroAsignadoAt).toBeNull();
    expect(despues.estado).toBe(EstadoPedido.PENDIENTE_PAGO);

    expect((await caja.obtenerColaVentanilla(tiendaId)).data.map((p) => p.id)).toEqual([
      esperando.id,
      ausente.id,
    ]);
    expect((await monitor.obtenerMonitorCajero(tiendaId)).colaSinAsignar.map((p) => p.id)).toEqual([
      esperando.id,
      ausente.id,
    ]);
    // El bucle que arregla: antes volvía a ser el primero y se llamaba otra vez.
    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(esperando.id);
  });

  it('una transferencia verificada que no se presentó pasa al final como cualquiera (no hay prioridad que la regrese)', async () => {
    const { caja } = servicios();
    const ausente = await crearPedido({
      llegoAHaceMin: 30,
      transferencia: { estado: E.VERIFICADO, verificadaHaceMin: 20 },
    });
    const esperando = await crearPedido({ llegoAHaceMin: 10 });

    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(ausente.id);
    await caja.noSePresento(ausente.id, cajero as never);

    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(esperando.id);
  });

  it('deja huella en el historial y avisa a la TV', async () => {
    const { caja } = servicios();
    const p = await crearPedido();
    await caja.llamarSiguiente(cajero as never);
    realtime.emitToTienda.mockClear();
    await caja.noSePresento(p.id, cajero as never);

    const h = await prisma.historialPedido.findFirst({
      where: { pedidoId: p.id, observacion: { contains: 'No se presentó' } },
    });
    expect(h).not.toBeNull();
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaId,
      'pedido.cajero-liberado',
      expect.objectContaining({ id: p.id }),
    );
  });

  it('solo el cajero que lo tiene (o un admin) puede marcarlo', async () => {
    const { caja } = servicios();
    const p = await crearPedido();
    await caja.llamarSiguiente(cajero as never);
    await expect(caja.noSePresento(p.id, otroCajero as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      caja.noSePresento(p.id, { userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN } as never),
    ).resolves.toBeDefined();
  });

  it('un pedido que nadie tiene en una ventanilla no se puede marcar', async () => {
    const { caja } = servicios();
    const p = await crearPedido();
    await expect(
      caja.noSePresento(p.id, { userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Ventanilla — soltarla no pierde a quien se estaba atendiendo', () => {
  it('los pedidos del cajero regresan a la fila conservando su lugar', async () => {
    const { caja, monitor, ventanillas } = servicios();
    const atendido = await crearPedido({ llegoAHaceMin: 30 });
    const esperando = await crearPedido({ llegoAHaceMin: 10 });
    await caja.llamarSiguiente(cajero as never); // el cajero tiene a `atendido`

    // Con el cajero en su ventanilla, la TV lo muestra ahí.
    const antes = await monitor.obtenerMonitorCajero(tiendaId);
    expect(antes.ventanillas[0].detallePedidos.map((p) => p.id)).toEqual([atendido.id]);

    const r = await ventanillas.liberar(cajero.userId, tiendaId);
    expect(r).toMatchObject({ ok: true, pedidosRegresadosALaFila: 1 });

    // Antes de este cambio el pedido quedaba asignado al cajero: invisible en la TV Y en la fila.
    const despues = await monitor.obtenerMonitorCajero(tiendaId);
    expect(despues.ventanillas[0].detallePedidos).toHaveLength(0);
    expect(despues.colaSinAsignar.map((p) => p.id)).toEqual([atendido.id, esperando.id]);
    expect((await caja.obtenerColaVentanilla(tiendaId)).data.map((p) => p.id)).toEqual([
      atendido.id,
      esperando.id,
    ]);
  });

  it('un cajero sin pedidos en la ventanilla la suelta sin más', async () => {
    const { ventanillas } = servicios();
    expect(await ventanillas.liberar(cajero.userId, tiendaId)).toMatchObject({
      ok: true,
      pedidosRegresadosALaFila: 0,
    });
  });
});

describe('Fila de caja — "Regresar a la cola hasta que se valide"', () => {
  async function conTransferenciaEnVentanilla(estado: E = E.PENDIENTE) {
    const { caja } = servicios();
    const p = await crearPedido({ llegoAHaceMin: 30, transferencia: { estado } });
    await crearPedido({ llegoAHaceMin: 10 }); // alguien detrás, para ver quién sigue
    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(p.id);
    return p;
  }

  it('la suelta de la ventanilla CONSERVANDO su lugar y deja la marca', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    const antes = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });

    await caja.esperarValidacion(p.id, cajero as never);

    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues.estado).toBe(EstadoPedido.PENDIENTE_PAGO);
    expect(despues.cajeroAsignadoId).toBeNull();
    expect(despues.cajeroAsignadoAt).toBeNull();
    expect(despues.esperaValidacionDesdeAt).not.toBeNull();
    // A diferencia de "No se presentó", el lugar es el mismo.
    expect(despues.colaCajaDesdeAt).toEqual(antes.colaCajaDesdeAt);
  });

  it('"Llamar siguiente" ya no lo vuelve a llamar mientras siga sin verificar (el bucle)', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    const detras = await prisma.pedido.findFirstOrThrow({
      where: { tiendaId, estado: EstadoPedido.PENDIENTE_PAGO, cajeroAsignadoId: null },
    });
    await caja.esperarValidacion(p.id, cajero as never);

    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(detras.id);
  });

  it('sigue en SU LUGAR en la consola y en la TV (sin distintivo en la pública), y la consola lo marca', async () => {
    const { caja, monitor } = servicios();
    const p = await conTransferenciaEnVentanilla();
    await caja.esperarValidacion(p.id, cajero as never);

    const consola = await caja.obtenerColaVentanilla(tiendaId);
    expect(consola.data[0].id).toBe(p.id);
    expect(consola.data[0].esperandoValidacion).toBe(true);
    expect(consola.data[1].esperandoValidacion).toBe(false);
    // "Llamar siguiente" no la toma, así que no cuenta como llamable (habilita el botón de la consola).
    expect(consola.meta).toMatchObject({ total: 2, llamables: 1 });

    const tv = await monitor.obtenerMonitorCajero(tiendaId);
    expect(tv.colaSinAsignar[0].id).toBe(p.id);
    expect(JSON.stringify(tv)).not.toMatch(/espera|validaci|transfer/i);
  });

  it('en cuanto Tesorería la verifica vuelve a ser llamable, en su lugar de siempre, sin limpiar nada', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    await caja.esperarValidacion(p.id, cajero as never);
    // Tesorería verifica mientras el cliente espera en la fila (detrás hay uno de efectivo)…
    await prisma.pedidoPagoTransferencia.updateMany({
      where: { pedidoId: p.id },
      data: {
        estado: E.VERIFICADO,
        verificadoAt: new Date(),
        montoVerificado: 100,
        verificadoPorId: cajero.userId,
      },
    });

    // …y la marca vieja ya no la excluye: conserva su lugar (llegó antes que el de efectivo), sin regla de prioridad.
    expect((await caja.llamarSiguiente(cajero as never)).pedidoId).toBe(p.id);
  });

  it('si otra cajera lo toma a mano (el cliente llegó a su ventanilla), la marca se limpia', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    await caja.esperarValidacion(p.id, cajero as never);

    await caja.tomarPedidoCajero(p.id, otroCajero as never);

    const t = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(t.cajeroAsignadoId).toBe(otroCajero.userId);
    expect(t.esperaValidacionDesdeAt).toBeNull();
  });

  it('solo cabe con una transferencia sin validar: efectivo o ya verificada → 400', async () => {
    const { caja } = servicios();
    const efectivo = await crearPedido({ llegoAHaceMin: 30 });
    await caja.llamarSiguiente(cajero as never);
    await expect(caja.esperarValidacion(efectivo.id, cajero as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await caja.liberarPedidoCajero(efectivo.id, cajero as never);
    const verificada = await crearPedido({
      llegoAHaceMin: 40,
      transferencia: { estado: E.VERIFICADO, verificadaHaceMin: 5 },
    });
    await caja.tomarPedidoCajero(verificada.id, cajero as never);
    await expect(caja.esperarValidacion(verificada.id, cajero as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Y no dejó marca en ninguno.
    const marcas = await prisma.pedido.count({
      where: { id: { in: [efectivo.id, verificada.id] }, esperaValidacionDesdeAt: { not: null } },
    });
    expect(marcas).toBe(0);
  });

  it('solo la cajera que lo tiene (o el admin): otra cajera → 403; sin asignar → 400', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    await expect(caja.esperarValidacion(p.id, otroCajero as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await caja.liberarPedidoCajero(p.id, cajero as never);
    await expect(caja.esperarValidacion(p.id, cajero as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const admin = { userId: -1, nombre: 'Admin', rol: RolUsuario.ADMIN, tiendaId };
    await expect(caja.esperarValidacion(p.id, admin as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deja huella en el historial y avisa a la TV y a las consolas (mismo evento que devolver)', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    realtime.emitToTienda.mockClear();

    await caja.esperarValidacion(p.id, cajero as never);

    const h = await prisma.historialPedido.findFirst({
      where: { pedidoId: p.id, observacion: { contains: 'hasta que se valide' } },
    });
    expect(h).not.toBeNull();
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      tiendaId,
      'pedido.cajero-liberado',
      expect.objectContaining({ id: p.id }),
    );
  });

  it('"mis pedidos" dice cuándo cabe el botón: solo con una transferencia sin validar', async () => {
    const { caja } = servicios();
    const transf = await crearPedido({
      llegoAHaceMin: 30,
      transferencia: { estado: E.EN_REVISION },
    });
    const efectivo = await crearPedido({ llegoAHaceMin: 20 });
    await caja.tomarPedidoCajero(transf.id, cajero as never);
    await caja.tomarPedidoCajero(efectivo.id, cajero as never);

    const mios = await caja.obtenerMisPedidosCajero(cajero.userId, tiendaId);
    expect(mios.find((x) => x.id === transf.id)?.puedeEsperarValidacion).toBe(true);
    expect(mios.find((x) => x.id === efectivo.id)?.puedeEsperarValidacion).toBe(false);
  });

  it('salir de PENDIENTE_PAGO limpia la marca (no sobrevive a un cambio de estado)', async () => {
    const { caja } = servicios();
    const p = await conTransferenciaEnVentanilla();
    await caja.esperarValidacion(p.id, cajero as never);
    const antes = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(antes.esperaValidacionDesdeAt).not.toBeNull();
    // `noSePresento` es la otra salida de la fila que reinicia el lugar: también la limpia.
    await caja.tomarPedidoCajero(p.id, cajero as never);
    await caja.noSePresento(p.id, cajero as never);
    const despues = await prisma.pedido.findUniqueOrThrow({ where: { id: p.id } });
    expect(despues.esperaValidacionDesdeAt).toBeNull();
  });
});
