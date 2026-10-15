import 'dotenv/config';
import {
  CanalOrigen,
  EstadoPedido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
  TipoNotificacion,
} from '@prisma/client';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PresenciaService } from '../pedidos/core/presencia.service';
import { SinRecogerService } from '../pedidos/core/sin-recoger.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { KioskoLlegadaService } from '../kiosko/kiosko-llegada.service';
import { MostradoresService } from '../mostradores/mostradores.service';
import { MostradorService } from './mostrador.service';
import { MostradorQueryService } from './mostrador-query.service';

/**
 * F22: el flujo de mostrador contra PostgreSQL REAL.
 *
 * Los specs con mocks fijan QUÉ llama cada servicio; no pueden decir si los
 * `where` de Prisma (`wherePresente`, `whereAusente`, las escrituras atómicas con
 * `updateMany`) hacen lo que prometen sobre filas de verdad. Este spec recorre los
 * escenarios del negocio con los servicios reales cableados entre sí y solo mockea
 * lo que sale de la base (correo y realtime). Mismo patrón que
 * `sync-postgres.spec.ts`: crea sus propias filas y las borra al terminar.
 */

jest.setTimeout(30_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);

const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn(), emitToUser: jest.fn() };
const enviar = jest.fn().mockResolvedValue([]);
const config = {
  get: jest.fn((clave: string) =>
    clave === 'app.pedidosSinRecoger'
      ? { recordatorioHoras: 24, vencidoHoras: 72, presenciaCaducaHoras: 8 }
      : 'secreto-de-prueba-de-32-caracteres-minimo',
  ),
};

let tiendaId: number;
let clienteId: number;
let operadorId: number;
let operador2Id: number;
const pedidoIds: number[] = [];
let consecutivo = 0;

let state: PedidoStateService;
let llegada: KioskoLlegadaService;
let presencia: PresenciaService;
let mostradores: MostradoresService;
let sinRecoger: SinRecogerService;
let mostrador: MostradorService;
let consultas: MostradorQueryService;

const usuarioOp = () => ({
  userId: operadorId,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId,
});

async function crearPedido(
  datos: {
    canal?: CanalOrigen;
    estado?: EstadoPedido;
    llegada?: Date | null;
    presente?: Date | null;
    espera?: Date | null;
    fechaPedido?: Date;
    modoEntrega?: ModoEntrega;
    descartada?: Date | null;
  } = {},
) {
  const canal = datos.canal ?? CanalOrigen.WEB;
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-F${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado: datos.estado ?? EstadoPedido.REVISADO,
      canalOrigen: canal,
      modoEntrega:
        datos.modoEntrega ??
        (canal === CanalOrigen.KIOSKO ? ModoEntrega.KIOSKO : ModoEntrega.RECOGER_TIENDA),
      clienteNombre: 'Cliente Flujo',
      clienteEmail: `flujo-${suffix}-${consecutivo}@test.local`,
      subtotal: 100,
      total: 100,
      llegadaAnunciadaAt: datos.llegada ?? null,
      llegadaDescartadaAt: datos.descartada ?? null,
      presenteDesdeAt:
        datos.presente !== undefined
          ? datos.presente
          : canal === CanalOrigen.KIOSKO
            ? (datos.fechaPedido ?? new Date())
            : (datos.llegada ?? null),
      esperaClienteDesdeAt: datos.espera ?? null,
      ...(datos.fechaPedido ? { fechaPedido: datos.fechaPedido } : {}),
    },
  });
  pedidoIds.push(p.id);
  return p;
}

const pausa = () => new Promise((r) => setTimeout(r, 250));
const leer = (id: number) => prisma.pedido.findUniqueOrThrow({ where: { id } });
const horas = (h: number) => new Date(Date.now() - h * 3_600_000);

beforeAll(async () => {
  await prisma.$connect();

  const tienda = await prisma.tienda.create({
    data: { nombre: `Flujo ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;

  const cliente = await prisma.usuario.create({
    data: {
      email: `flujo-cli-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Cliente',
      rol: 'CLIENTE',
    },
  });
  clienteId = cliente.id;
  const op = await prisma.usuario.create({
    data: {
      email: `flujo-op-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Ana',
      apellido: 'Mostrador',
      rol: 'MOSTRADOR',
      tiendaId,
    },
  });
  operadorId = op.id;
  const op2 = await prisma.usuario.create({
    data: {
      email: `flujo-op2-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Beto',
      apellido: 'Mostrador',
      rol: 'MOSTRADOR',
      tiendaId,
    },
  });
  operador2Id = op2.id;

  const access = new PedidoAccessService(prisma as never);
  state = new PedidoStateService(
    prisma as never,
    { enviar } as never,
    realtime as never,
    access,
    {} as never,
  );
  llegada = new KioskoLlegadaService(
    prisma as never,
    {} as never,
    realtime as never,
    config as never,
  );
  presencia = new PresenciaService(prisma as never, state, access, realtime as never, llegada);
  presencia.onModuleInit();
  mostradores = new MostradoresService(prisma as never, realtime as never);
  sinRecoger = new SinRecogerService(
    prisma as never,
    config as never,
    realtime as never,
    { enviar } as never,
  );
  mostrador = new MostradorService(
    prisma as never,
    state,
    access,
    new ReposicionService(prisma as never, realtime as never),
    realtime as never,
    {} as never,
    llegada,
    presencia,
    mostradores,
    config as never,
  );
  consultas = new MostradorQueryService(prisma as never, state, config as never);
});

afterAll(async () => {
  await prisma.pedidoReposicion.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.mostrador.deleteMany({ where: { tiendaId } });
  await prisma.usuario.deleteMany({ where: { id: { in: [clienteId, operadorId, operador2Id] } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  enviar.mockClear();
  realtime.emitToPedido.mockClear();
  realtime.emitToTienda.mockClear();
});

describe('avisar llegada: solo mientras no haya un aviso vigente', () => {
  it('el primer aviso web escribe la presencia; repetirlo no cambia NADA', async () => {
    const p = await crearPedido({ estado: EstadoPedido.REVISADO });

    const primero = await llegada.confirmarDesdeCliente(p.id);
    const tras1 = await leer(p.id);
    const segundo = await llegada.confirmarDesdeCliente(p.id);
    const tras2 = await leer(p.id);

    expect(primero.reanudado).toBe(true);
    expect(segundo.reanudado).toBe(false);
    expect(tras1.llegadaAnunciadaAt).not.toBeNull();
    expect(tras1.presenteDesdeAt).not.toBeNull();
    // Idéntico: ni el timestamp ni el contador se movieron.
    expect(tras2.llegadaAnunciadaAt).toEqual(tras1.llegadaAnunciadaAt);
    expect(tras2.presenteDesdeAt).toEqual(tras1.presenteDesdeAt);
    expect(tras2.llegadaAnunciadaCount).toBe(1);
  });

  it('el aviso ANTICIPADO funciona con el pedido todavía en bodega', async () => {
    const p = await crearPedido({ estado: EstadoPedido.EN_REVISION });

    const r = await llegada.confirmarDesdeCliente(p.id);

    expect(r.reanudado).toBe(true);
    const tras = await leer(p.id);
    expect(tras.llegadaAnunciadaAt).not.toBeNull();
    // Sigue en bodega: el aviso es una señal, no un estado.
    expect(tras.estado).toBe(EstadoPedido.EN_REVISION);
  });

  it('descartar y re-avisar REINICIA la espera (no hereda la hora del aviso viejo)', async () => {
    const p = await crearPedido({ llegada: horas(3), presente: horas(3) });
    const viejo = (await leer(p.id)).presenteDesdeAt!;

    await presencia.descartar(p.id, usuarioOp());
    expect((await leer(p.id)).llegadaDescartadaAt).not.toBeNull();
    await llegada.confirmarDesdeCliente(p.id);
    const nuevo = await leer(p.id);

    expect(nuevo.llegadaDescartadaAt).toBeNull();
    expect(nuevo.presenteDesdeAt!.getTime()).toBeGreaterThan(viejo.getTime() + 60_000);
    // Y los descartes se conservan: es lo que cierra el botón web a la segunda.
    expect(nuevo.llegadaDescartes).toBe(1);
  });

  it('a la SEGUNDA vez descartada, el botón web se cierra; el operador sí puede', async () => {
    const p = await crearPedido({ llegada: horas(1), presente: horas(1) });
    await presencia.descartar(p.id, usuarioOp());
    await llegada.confirmarDesdeCliente(p.id);
    await presencia.descartar(p.id, usuarioOp());

    await expect(llegada.confirmarDesdeCliente(p.id)).rejects.toMatchObject({
      response: expect.objectContaining({ codigo: 'AVISO_BLOQUEADO' }),
    });
    // El operador lo avala: el cliente está enfrente.
    await expect(llegada.confirmarDesdeMostrador(p.id, usuarioOp())).resolves.toMatchObject({
      reanudado: true,
    });
    expect((await leer(p.id)).llegadaDescartes).toBe(2);
  });

  it('dos avisos SIMULTÁNEOS: solo uno gana la carrera', async () => {
    const p = await crearPedido({ estado: EstadoPedido.REVISADO });

    const [a, b] = await Promise.all([
      llegada.confirmarDesdeCliente(p.id),
      llegada.confirmarDesdeCliente(p.id),
    ]);

    expect([a.reanudado, b.reanudado].filter(Boolean)).toHaveLength(1);
    expect((await leer(p.id)).llegadaAnunciadaCount).toBe(1);
  });
});

describe('cliente con una propuesta pendiente que llega a la tienda', () => {
  it('pasa a REVISADO sin correo y entra a la cola', async () => {
    // El comentario de `destinoTrasSurtidoIncompleto` prometía esto y el código
    // nunca existió: el pedido quedaba invisible para el operador.
    const p = await crearPedido({
      estado: EstadoPedido.ESPERANDO_APROBACION,
      espera: horas(2),
    });

    await llegada.confirmarDesdeCliente(p.id);

    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.REVISADO);
    // No es un ciclo de espera nuevo: la bolsa lleva el mismo tiempo apartada.
    expect(tras.esperaClienteDesdeAt!.getTime()).toBe(p.esperaClienteDesdeAt!.getTime());
    expect(enviar).not.toHaveBeenCalled();

    const cola = await consultas.obtenerCola(tiendaId, 1, 100);
    expect(cola.data.map((x) => x.id)).toContain(p.id);

    const historial = await prisma.historialPedido.findMany({ where: { pedidoId: p.id } });
    expect(historial.some((h) => /propuesta pendiente/i.test(h.observacion ?? ''))).toBe(true);
  });
});

describe('el cliente llamado se va: descartar no deja el pedido huérfano', () => {
  it('EN_ATENCION + descartar → vuelve a REVISADO y aparece en "Sin aviso"', async () => {
    const p = await crearPedido({
      estado: EstadoPedido.EN_ATENCION,
      llegada: horas(1),
      presente: horas(1),
      espera: horas(2),
    });

    await presencia.descartar(p.id, usuarioOp());

    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.REVISADO);
    expect(tras.llamadoAt).toBeNull();
    expect(tras.llamadoPorId).toBeNull();
    expect(tras.llamadoMostradorId).toBeNull();
    // Ya no está en la cola ni en la TV...
    const cola = await consultas.obtenerCola(tiendaId, 1, 100);
    expect(cola.data.map((x) => x.id)).not.toContain(p.id);
    // ...pero NO desaparece: la lista "Sin aviso" lo muestra.
    const sinAviso = await consultas.obtenerSinAviso(tiendaId, 1, 100);
    expect(sinAviso.data.map((x) => x.id)).toContain(p.id);
  });

  it('un pedido de KIOSKO descartado sale de la cola y pasa a "Sin aviso"', async () => {
    const p = await crearPedido({ canal: CanalOrigen.KIOSKO, espera: horas(1) });
    expect((await consultas.obtenerCola(tiendaId, 1, 100)).data.map((x) => x.id)).toContain(p.id);

    await presencia.descartar(p.id, usuarioOp());

    expect((await consultas.obtenerCola(tiendaId, 1, 100)).data.map((x) => x.id)).not.toContain(
      p.id,
    );
    expect((await consultas.obtenerSinAviso(tiendaId, 1, 100)).data.map((x) => x.id)).toContain(
      p.id,
    );
  });

  it('todo pedido apartado está en EXACTAMENTE una lista: cola o "Sin aviso"', async () => {
    // Los dos `where` son complementarios: si dejaran de serlo, un pedido
    // desaparecería de la consola.
    const cola = await consultas.obtenerCola(tiendaId, 1, 500);
    const sin = await consultas.obtenerSinAviso(tiendaId, 1, 500);
    const enCola = new Set(
      cola.data.filter((p) => p.estado === EstadoPedido.REVISADO).map((p) => p.id),
    );
    const enSin = new Set(
      sin.data.filter((p) => p.estado === EstadoPedido.REVISADO).map((p) => p.id),
    );
    for (const id of enCola) expect(enSin.has(id)).toBe(false);

    const apartados = await prisma.pedido.findMany({
      where: { tiendaId, estado: EstadoPedido.REVISADO },
      select: { id: true },
    });
    for (const { id } of apartados) {
      expect(enCola.has(id) || enSin.has(id)).toBe(true);
    }
  });
});

describe('llamar con mostrador', () => {
  it('persiste quién llamó y desde qué mostrador, y lo limpia al devolver a la cola', async () => {
    const [m1] = await mostradores.crearN(tiendaId, 2);
    await mostradores.elegir(operadorId, tiendaId, m1.id);
    const p = await crearPedido({ llegada: horas(1), presente: horas(1), espera: horas(1) });

    const r = await mostrador.llamar(p.id, usuarioOp());

    expect(r.mostradorNumero).toBe(m1.numero);
    const llamado = await leer(p.id);
    expect(llamado.estado).toBe(EstadoPedido.EN_ATENCION);
    expect(llamado.llamadoMostradorId).toBe(m1.id);
    expect(llamado.llamadoPorId).toBe(operadorId);
    expect(llamado.llamadoAt).not.toBeNull();

    // La consola de otro operador ve quién lo atiende y dónde.
    const cola = await consultas.obtenerCola(tiendaId, 1, 100);
    const fila = cola.data.find((x) => x.id === p.id)!;
    expect(fila.mostradorNumero).toBe(m1.numero);
    expect(fila.atendidoPorNombre).toBe('Ana Mostrador');

    await mostrador.devolverACola(p.id, usuarioOp());
    const devuelto = await leer(p.id);
    expect(devuelto.estado).toBe(EstadoPedido.REVISADO);
    expect(devuelto.llamadoAt).toBeNull();
    expect(devuelto.llamadoPorId).toBeNull();
    expect(devuelto.llamadoMostradorId).toBeNull();
    // "Devolver a la cola" CONSERVA el lugar.
    expect(devuelto.presenteDesdeAt).toEqual(p.presenteDesdeAt);
  });

  it('con mostradores configurados y sin elegir, no llama', async () => {
    const p = await crearPedido({ llegada: horas(1), presente: horas(1) });
    // El operador 2 no eligió ninguno.
    await expect(
      mostrador.llamar(p.id, { ...usuarioOp(), userId: operador2Id, nombre: 'Beto' }),
    ).rejects.toThrow(/elige tu mostrador/i);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
  });

  it('dos operadores no pueden elegir el mismo mostrador', async () => {
    const [, m2] = await prisma.mostrador.findMany({
      where: { tiendaId },
      orderBy: { numero: 'asc' },
    });
    await mostradores.elegir(operador2Id, tiendaId, m2.id);
    await expect(mostradores.elegir(operadorId, tiendaId, m2.id)).rejects.toThrow(/ocupado/i);
  });

  it('no llama a un cliente que no está en la tienda', async () => {
    const p = await crearPedido({ llegada: null, presente: null });
    await expect(mostrador.llamar(p.id, usuarioOp())).rejects.toThrow(/no ha avisado/i);
    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
  });
});

describe('"no se presentó" y la cola justa', () => {
  it('la primera vez pasa al FINAL; la segunda se descarta su aviso', async () => {
    const hace = horas(2);
    const a = await crearPedido({ llegada: hace, presente: hace, espera: hace });
    const b = await crearPedido({ llegada: horas(1), presente: horas(1), espera: hace });
    await mostrador.llamar(a.id, usuarioOp());

    const r1 = await mostrador.noSePresento(a.id, usuarioOp());

    expect(r1.descartado).toBe(false);
    const trasUna = await leer(a.id);
    expect(trasUna.estado).toBe(EstadoPedido.REVISADO);
    expect(trasUna.llamadasFallidas).toBe(1);
    // Ahora está DETRÁS de `b`, que llegó una hora después.
    const orden = (await consultas.obtenerCola(tiendaId, 1, 100)).data.map((x) => x.id);
    expect(orden.indexOf(b.id)).toBeLessThan(orden.indexOf(a.id));

    await mostrador.llamar(a.id, usuarioOp());
    const r2 = await mostrador.noSePresento(a.id, usuarioOp());

    expect(r2.descartado).toBe(true);
    const trasDos = await leer(a.id);
    expect(trasDos.llegadaDescartadaAt).not.toBeNull();
    expect(trasDos.llegadaDescartes).toBe(1);
  });

  it('primero llegado, primero atendido: un kiosko que esperó más va ANTES que un web que acaba de avisar', async () => {
    // El bug: se ordenaba por `llegadaAnunciadaAt nulls last` y TODO web con aviso
    // pasaba delante de cualquier kiosko.
    const kiosko = await crearPedido({
      canal: CanalOrigen.KIOSKO,
      fechaPedido: horas(0.75),
      espera: horas(1),
    });
    const web = await crearPedido({ llegada: horas(0.1), presente: horas(0.1), espera: horas(1) });

    const orden = (await consultas.obtenerCola(tiendaId, 1, 100)).data.map((x) => x.id);

    expect(orden.indexOf(kiosko.id)).toBeLessThan(orden.indexOf(web.id));
    const siguiente = await prisma.pedido.findFirst({
      where: {
        tiendaId,
        estado: EstadoPedido.REVISADO,
        id: { in: [kiosko.id, web.id] },
        llegadaDescartadaAt: null,
      },
      orderBy: [{ presenteDesdeAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
    expect(siguiente!.id).toBe(kiosko.id);
  });
});

describe('el correo "listo en tienda" es solo del primer paso a REVISADO', () => {
  const llamadas = () =>
    enviar.mock.calls.filter(([, tipo]) => tipo === TipoNotificacion.LISTO_EN_TIENDA);

  it('el primer REVISADO avisa; devolver a la cola y volver de un ajuste NO', async () => {
    const p = await crearPedido({ estado: EstadoPedido.EN_REVISION });
    const op = usuarioOp();

    await state.cambiarEstado(p.id, { nuevoEstado: EstadoPedido.REVISADO }, op, {
      asignacion: 'limpiar',
    });
    // `dispararEfectos` relee el pedido y manda el correo en una promesa suelta: con
    // una base real eso es un viaje de ida y vuelta, no un tick.
    await pausa();
    expect(llamadas()).toHaveLength(1);

    // Llamar y devolver: EN_ATENCION → REVISADO.
    await prisma.pedido.update({
      where: { id: p.id },
      data: { llegadaAnunciadaAt: new Date(), presenteDesdeAt: new Date() },
    });
    await mostrador.llamar(p.id, op);
    await mostrador.devolverACola(p.id, op);
    // Ajuste: REVISADO → EN_REVISION → REVISADO.
    await state.cambiarEstado(p.id, { nuevoEstado: EstadoPedido.EN_REVISION }, op, {
      asignacion: 'limpiar',
    });
    await state.cambiarEstado(p.id, { nuevoEstado: EstadoPedido.REVISADO }, op, {
      asignacion: 'limpiar',
    });
    await pausa();

    expect(llamadas()).toHaveLength(1);
  });
});

describe('pedidos sin recoger: recordatorio, vencidos y cancelación', () => {
  it('el barrido manda UN recordatorio por pedido, aunque corra dos veces', async () => {
    const p = await crearPedido({ espera: horas(30) });

    const r1 = await sinRecoger.barrer();
    const r2 = await sinRecoger.barrer();

    expect(r1.recordatorios).toBeGreaterThanOrEqual(1);
    expect(r2.recordatorios).toBe(0);
    const aEste = enviar.mock.calls.filter(
      ([ped, tipo]) => ped.id === p.id && tipo === TipoNotificacion.RECORDATORIO_RECOGER,
    );
    expect(aEste).toHaveLength(1);
    expect((await leer(p.id)).recordatorioRecogerAt).not.toBeNull();
  });

  it('no le pregunta "¿aún lo quieres?" a quien está en la tienda', async () => {
    const p = await crearPedido({ llegada: horas(1), presente: horas(1), espera: horas(30) });
    await sinRecoger.barrer();
    expect(enviar.mock.calls.some(([ped]) => ped.id === p.id)).toBe(false);
    expect((await leer(p.id)).recordatorioRecogerAt).toBeNull();
  });

  it('no recuerda un pedido que aún no cumple 24 h', async () => {
    const p = await crearPedido({ espera: horas(5) });
    await sinRecoger.barrer();
    expect(enviar.mock.calls.some(([ped]) => ped.id === p.id)).toBe(false);
  });

  it('un aviso de llegada sin atender en 8 h caduca solo, sin contar como descarte', async () => {
    const p = await crearPedido({ llegada: horas(9), presente: horas(9), espera: horas(9) });

    const r = await sinRecoger.barrer();

    expect(r.caducadas).toBeGreaterThanOrEqual(1);
    const tras = await leer(p.id);
    expect(tras.llegadaDescartadaAt).not.toBeNull();
    expect(tras.llegadaDescartes).toBe(0);
  });

  it('"sí, aún lo quiero" reinicia la espera y tiene tope de 2', async () => {
    const p = await crearPedido({ espera: horas(30) });
    await prisma.pedido.update({
      where: { id: p.id },
      data: { recordatorioRecogerAt: horas(5) },
    });

    await sinRecoger.confirmarInteres(p.id, clienteId);
    const tras = await leer(p.id);
    expect(tras.recordatorioRecogerAt).toBeNull();
    expect(tras.interesConfirmadoCount).toBe(1);
    expect(Date.now() - tras.esperaClienteDesdeAt!.getTime()).toBeLessThan(10_000);

    await sinRecoger.confirmarInteres(p.id, clienteId);
    await expect(sinRecoger.confirmarInteres(p.id, clienteId)).rejects.toThrow(/dos ocasiones/i);
  });

  it('"Sin aviso" marca VENCIDOS los de 72 h y el filtro los aísla', async () => {
    const viejo = await crearPedido({ espera: horas(80) });
    const reciente = await crearPedido({ espera: horas(10) });

    const todos = await consultas.obtenerSinAviso(tiendaId, 1, 100, 'todos');
    const vencidos = await consultas.obtenerSinAviso(tiendaId, 1, 100, 'vencidos');

    expect(todos.data.find((x) => x.id === viejo.id)!.vencido).toBe(true);
    expect(todos.data.find((x) => x.id === reciente.id)!.vencido).toBe(false);
    expect(vencidos.data.map((x) => x.id)).toContain(viejo.id);
    expect(vencidos.data.map((x) => x.id)).not.toContain(reciente.id);
    expect(todos.meta.vencidos).toBeGreaterThanOrEqual(1);
    // Los más viejos van primero.
    const ids = todos.data.map((x) => x.id);
    expect(ids.indexOf(viejo.id)).toBeLessThan(ids.indexOf(reciente.id));
  });

  it('cancelar vencidos: cancela el vencido, crea la reposición con el motivo y OMITE al que ya llegó', async () => {
    const vencido = await crearPedido({ espera: horas(80) });
    const yaLlego = await crearPedido({ espera: horas(80) });
    const reciente = await crearPedido({ espera: horas(10) });
    // Entre que el operador vio la lista y apretó "Cancelar", el cliente llegó.
    await llegada.confirmarDesdeCliente(yaLlego.id);

    const r = await mostrador.cancelarVencidos(usuarioOp(), [vencido.id, yaLlego.id, reciente.id]);

    expect(r.canceladas).toEqual([vencido.id]);
    expect(r.omitidas.map((o) => o.id).sort()).toEqual([yaLlego.id, reciente.id].sort());
    expect((await leer(vencido.id)).estado).toBe(EstadoPedido.CANCELADO);
    expect((await leer(yaLlego.id)).estado).toBe(EstadoPedido.REVISADO);
    expect((await leer(reciente.id)).estado).toBe(EstadoPedido.REVISADO);
    // El motivo que lee el cliente en el correo de cancelación.
    const rep = await prisma.pedidoReposicion.findUnique({ where: { pedidoId: vencido.id } });
    expect(rep?.motivo).toMatch(/3 días/);
    expect(rep?.motivo).toMatch(/recordatorio/);
  });

  it('cancelar vencidos también cubre ESPERANDO_APROBACION sin respuesta', async () => {
    const p = await crearPedido({ estado: EstadoPedido.ESPERANDO_APROBACION, espera: horas(90) });
    const r = await mostrador.cancelarVencidos(usuarioOp(), [p.id]);
    expect(r.canceladas).toEqual([p.id]);
  });
});

describe('traer a entrega: el cliente enfrente aparece en la cola', () => {
  it('un web traído desde asesoría queda en la cola, no escondido en "Sin aviso"', async () => {
    const p = await crearPedido({ estado: EstadoPedido.EN_ASESORIA });

    await mostrador.traerAEntrega(p.id, usuarioOp());

    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.REVISADO);
    expect(tras.llegadaAnunciadaAt).not.toBeNull();
    const cola = await consultas.obtenerCola(tiendaId, 1, 100);
    expect(cola.data.map((x) => x.id)).toContain(p.id);
  });
});
