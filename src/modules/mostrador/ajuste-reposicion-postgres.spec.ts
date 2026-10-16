import 'dotenv/config';
import {
  CanalOrigen,
  EstadoPedido,
  EstadoReposicion,
  EstadoSurtido,
  ModoEntrega,
  PrismaClient,
  RolUsuario,
} from '@prisma/client';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { PresenciaService } from '../pedidos/core/presencia.service';
import { ReposicionService } from '../pedidos/reposicion/reposicion.service';
import { KioskoLlegadaService } from '../kiosko/kiosko-llegada.service';
import { MostradoresService } from '../mostradores/mostradores.service';
import { SurtidoService } from '../pedidos/bodega/surtido.service';
import { MostradorService } from './mostrador.service';

/**
 * Oct 2026 (propuestas, decisión 4): el ajuste de mostrador que solo QUITA se
 * resuelve en el lugar y pasa a reposición — contra PostgreSQL REAL.
 *
 * Los specs con mocks fijan QUÉ llama cada servicio. Lo que no pueden decir es si
 * lo que queda en las filas es coherente: `piezasRetiradas` sumado en el mismo
 * update, la fila de reposición fusionada con la de una cancelación posterior
 * (`pedidoId` es único), el estado que de verdad queda en la BD y la llamada que
 * sobrevive. Mismo patrón que `mostrador-flujo-postgres.spec.ts`: servicios reales
 * cableados, solo se mockea lo que sale de la base (correo y realtime), y el spec
 * crea sus propias filas y las borra al terminar.
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
let bodegueroId: number;
let productoId: number;
const pedidoIds: number[] = [];
let consecutivo = 0;

let mostrador: MostradorService;
let surtido: SurtidoService;

const usuarioBodega = () => ({
  userId: bodegueroId,
  nombre: 'Beto Bodega',
  rol: RolUsuario.BODEGA,
  tiendaId,
});

const usuarioOp = () => ({
  userId: operadorId,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId,
});

interface LineaSemilla {
  cantidad: number;
  surtida: number;
  piezasRetiradas?: number;
  estadoSurtido?: EstadoSurtido;
  /** Una línea que bodega no encontró (o que ya salió del pedido). */
  cancelada?: boolean;
}

/** Un pedido con líneas de $100 por pieza. Devuelve el pedido con sus items. */
async function crearPedido(
  lineas: LineaSemilla[],
  extra: { estado?: EstadoPedido; llamadoAt?: Date | null } = {},
) {
  // Una línea cancelada no se cobra.
  const subtotal = lineas.reduce((a, l) => a + (l.cancelada ? 0 : l.cantidad * 100), 0);
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-A${suffix}-${++consecutivo}`,
      usuarioId: clienteId,
      tiendaId,
      estado: extra.estado ?? EstadoPedido.REVISADO,
      canalOrigen: CanalOrigen.KIOSKO,
      modoEntrega: ModoEntrega.KIOSKO,
      clienteNombre: 'Cliente Ajuste',
      clienteEmail: `ajuste-${suffix}-${consecutivo}@test.local`,
      subtotal,
      total: subtotal,
      presenteDesdeAt: new Date(),
      llamadoAt: extra.llamadoAt ?? null,
      items: {
        create: lineas.map((l, i) => ({
          productoId,
          cantidad: l.cantidad,
          cantidadPedida: l.cantidad,
          cantidadSurtida: l.surtida,
          piezasRetiradas: l.piezasRetiradas ?? 0,
          estadoSurtido: l.estadoSurtido ?? EstadoSurtido.COMPLETO,
          cancelada: l.cancelada ?? false,
          precioUnitario: 100,
          subtotal: l.cantidad * 100,
          productoNombre: `Playera ${i + 1}`,
          productoCodigo: `T-${suffix}`,
          corridaNombre: 'Adulto',
          tallaNombre: 'M',
          colorNombre: 'Negro',
        })),
      },
    },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  pedidoIds.push(p.id);
  return p;
}

const leer = (id: number) =>
  prisma.pedido.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { id: 'asc' } } },
  });
const reposicionDe = (pedidoId: number) =>
  prisma.pedidoReposicion.findUnique({ where: { pedidoId } });
const entradas = (r: { items: unknown } | null) =>
  ((r?.items ?? []) as Array<{ id: number; cantidad: number; deCancelacion?: boolean }>).map(
    (i) => [i.id, i.cantidad],
  );

beforeAll(async () => {
  await prisma.$connect();

  const tienda = await prisma.tienda.create({
    data: { nombre: `Ajuste ${suffix}`, direccion: 'x', ciudad: 'x', estado: 'x' },
  });
  tiendaId = tienda.id;

  const cliente = await prisma.usuario.create({
    data: {
      email: `ajuste-cli-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Cliente',
      rol: 'CLIENTE',
    },
  });
  clienteId = cliente.id;
  const op = await prisma.usuario.create({
    data: {
      email: `ajuste-op-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Ana',
      apellido: 'Mostrador',
      rol: 'MOSTRADOR',
      tiendaId,
    },
  });
  operadorId = op.id;
  const bodeguero = await prisma.usuario.create({
    data: {
      email: `ajuste-bod-${suffix}@test.local`,
      password: 'integration-test-only',
      nombre: 'Beto',
      apellido: 'Bodega',
      rol: 'BODEGA',
      tiendaId,
    },
  });
  bodegueroId = bodeguero.id;
  const producto = await prisma.producto.create({
    data: { codigo: `T-${suffix}`, nombre: 'Playera de prueba' },
  });
  productoId = producto.id;

  const access = new PedidoAccessService(prisma as never);
  const state = new PedidoStateService(
    prisma as never,
    { enviar } as never,
    realtime as never,
    access,
    {} as never,
  );
  const llegada = new KioskoLlegadaService(
    prisma as never,
    {} as never,
    realtime as never,
    config as never,
  );
  const presencia = new PresenciaService(
    prisma as never,
    state,
    access,
    realtime as never,
    llegada,
  );
  presencia.onModuleInit();
  surtido = new SurtidoService(
    prisma as never,
    access,
    state,
    { enviar } as never,
    realtime as never,
    { resolverImagen: (u: string | null) => u } as never,
  );
  mostrador = new MostradorService(
    prisma as never,
    state,
    access,
    new ReposicionService(prisma as never, realtime as never),
    realtime as never,
    { columnaParaPedido: jest.fn(async () => 'lista1') } as never,
    llegada,
    presencia,
    new MostradoresService(prisma as never, realtime as never, {} as never),
    config as never,
  );
});

afterAll(async () => {
  await prisma.pedidoReposicion.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.producto.deleteMany({ where: { id: productoId } });
  await prisma.mostrador.deleteMany({ where: { tiendaId } });
  await prisma.usuario.deleteMany({ where: { id: { in: [clienteId, operadorId, bodegueroId] } } });
  await prisma.tienda.deleteMany({ where: { id: tiendaId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  enviar.mockClear();
  realtime.emitToPedido.mockClear();
  realtime.emitToTienda.mockClear();
});

describe('quitar y bajar en mostrador: queda en el área de entrega y pasa a reposición', () => {
  it('deja las filas coherentes: cantidades, hallazgo, piezasRetiradas, total y reposición', async () => {
    const p = await crearPedido([
      { cantidad: 10, surtida: 10 },
      { cantidad: 4, surtida: 4 },
    ]);
    const [a, b] = p.items;

    const r = await mostrador.ajustar(p.id, usuarioOp(), 'Baja el primero a 7 y quita el segundo', [
      { tipo: 'parcial', itemId: a.id, cantidad: 7 } as never,
      { tipo: 'no-disponible', itemId: b.id } as never,
    ]);

    const tras = await leer(p.id);
    // Sigue donde el cliente lo está esperando: no pasó por bodega.
    expect(tras.estado).toBe(EstadoPedido.REVISADO);
    expect(tras.asignadoAId).toBeNull();
    expect(r.vaABodega).toBe(false);
    expect(r.piezasAReposicion).toBe(7);

    const [ta, tb] = tras.items;
    // "Pediste 10 · Hay 10 · Te llevas 7": el hallazgo no se pisa con la decisión.
    expect(ta).toMatchObject({
      cantidad: 7,
      cantidadSurtida: 10,
      estadoSurtido: EstadoSurtido.COMPLETO,
      piezasRetiradas: 3,
      cancelada: false,
    });
    // La línea quitada conserva el hallazgo (F20) y ya cuenta como sacada.
    expect(tb).toMatchObject({ cancelada: true, cantidadSurtida: 4, piezasRetiradas: 4 });
    // El dinero: solo se cobran las 7 piezas que se queda.
    expect(Number(tras.subtotal)).toBe(700);

    const rep = await reposicionDe(p.id);
    expect(rep?.estado).toBe(EstadoReposicion.PENDIENTE);
    expect(rep?.motivo).toBeNull();
    expect(entradas(rep)).toEqual([
      [a.id, 3],
      [b.id, 4],
    ]);

    // Auditoría: el servicio escribe la fila, porque no hubo transición.
    const historial = await prisma.historialPedido.findMany({
      where: { pedidoId: p.id },
      orderBy: { id: 'asc' },
    });
    expect(historial.at(-1)?.observacion).toMatch(/2 cambio\(s\).*sin pasar por bodega/);
    expect(historial.at(-1)?.estadoAnterior).toBe(EstadoPedido.REVISADO);
    expect(historial.at(-1)?.estadoNuevo).toBe(EstadoPedido.REVISADO);

    // Bodega se entera por el evento propio (no hubo `pedido.estado`).
    expect(realtime.emitToTienda).toHaveBeenCalledWith(tiendaId, 'reposicion.creada', {
      pedidoId: p.id,
      piezas: 7,
    });
  });

  it('si el cliente cancela DESPUÉS, la bolsa restante se suma a la misma fila', async () => {
    // Es el bug que se evitó: `pedidoId` es único y `crearDesdePedido` salía si ya
    // había fila, así que las 7 piezas que seguían en la bolsa no volvían nunca.
    const p = await crearPedido([
      { cantidad: 10, surtida: 10 },
      { cantidad: 4, surtida: 4 },
    ]);
    const [a, b] = p.items;
    await mostrador.ajustar(p.id, usuarioOp(), 'Baja y quita', [
      { tipo: 'parcial', itemId: a.id, cantidad: 7 } as never,
      { tipo: 'no-disponible', itemId: b.id } as never,
    ]);

    await mostrador.cancelar(p.id, usuarioOp(), 'Ya no lo quiere');

    expect((await leer(p.id)).estado).toBe(EstadoPedido.CANCELADO);
    const rep = await reposicionDe(p.id);
    expect(rep?.estado).toBe(EstadoReposicion.PENDIENTE);
    // A: 3 que sacó el operador + 7 que seguían en la bolsa. B: ya salió entera.
    expect(entradas(rep)).toEqual([
      [a.id, 10],
      [b.id, 4],
    ]);
    // `motivo` es el texto del correo de cancelación.
    expect(rep?.motivo).toBe('Ya no lo quiere');
    const marcadas = (rep?.items as Array<{ id: number; deCancelacion?: boolean }>).filter(
      (i) => i.deCancelacion,
    );
    expect(marcadas.map((i) => i.id)).toEqual([a.id]);
  });

  it('un segundo ajuste no vuelve a listar lo que el primero ya sacó', async () => {
    const p = await crearPedido([
      { cantidad: 10, surtida: 10 },
      { cantidad: 4, surtida: 4 },
    ]);
    const [a] = p.items;

    await mostrador.ajustar(p.id, usuarioOp(), 'Baja a 7', [
      { tipo: 'parcial', itemId: a.id, cantidad: 7 } as never,
    ]);
    await mostrador.ajustar(p.id, usuarioOp(), 'Baja a 5', [
      { tipo: 'parcial', itemId: a.id, cantidad: 5 } as never,
    ]);

    const tras = await leer(p.id);
    expect(tras.items[0]).toMatchObject({ cantidad: 5, cantidadSurtida: 10, piezasRetiradas: 5 });
    // 3 + 2, en UNA entrada: la lista dice cuánto hay que devolver en total.
    expect(entradas(await reposicionDe(p.id))).toEqual([[a.id, 5]]);
  });
});

describe('el pedido se queda donde el cliente lo está esperando', () => {
  it('EN_ATENCION conserva la llamada: la TV sigue diciendo "te toca"', async () => {
    const llamadoAt = new Date(Date.now() - 60_000);
    const p = await crearPedido([{ cantidad: 6, surtida: 6 }], {
      estado: EstadoPedido.EN_ATENCION,
      llamadoAt,
    });

    await mostrador.ajustar(p.id, usuarioOp(), 'Baja a 4', [
      { tipo: 'parcial', itemId: p.items[0].id, cantidad: 4 } as never,
    ]);

    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.EN_ATENCION);
    expect(tras.llamadoAt).toEqual(llamadoAt);
  });

  it('ESPERANDO_APROBACION pasa a REVISADO, con propuesta SUPERADA y sin correo', async () => {
    const p = await crearPedido(
      [
        { cantidad: 6, surtida: 6 },
        { cantidad: 2, surtida: 2 },
      ],
      { estado: EstadoPedido.ESPERANDO_APROBACION },
    );
    await prisma.pedidoPropuesta.create({
      data: {
        pedidoId: p.id,
        creadaPorId: operadorId,
        creadaPorRol: RolUsuario.BODEGA,
        items: [],
        total: 0,
      },
    });

    await mostrador.ajustar(p.id, usuarioOp(), 'Quita el segundo', [
      { tipo: 'no-disponible', itemId: p.items[1].id } as never,
    ]);

    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
    const propuesta = await prisma.pedidoPropuesta.findFirstOrThrow({ where: { pedidoId: p.id } });
    expect(propuesta.estado).toBe('SUPERADA');
    // "Tu pedido ya está listo en tienda" a quien está de pie en el mostrador es ruido.
    expect(enviar).not.toHaveBeenCalled();
    expect(entradas(await reposicionDe(p.id))).toEqual([[p.items[1].id, 2]]);
  });
});

describe('hay algo que surtir: el pedido viaja a bodega', () => {
  it('sube una línea y quita otra: EN_REVISION sin asignar, y lo quitado igual se repone', async () => {
    const p = await crearPedido([
      { cantidad: 5, surtida: 5 },
      { cantidad: 3, surtida: 3 },
    ]);
    const [a, b] = p.items;

    const r = await mostrador.ajustar(p.id, usuarioOp(), 'Sube el primero, quita el segundo', [
      { tipo: 'parcial', itemId: a.id, cantidad: 8 } as never,
      { tipo: 'no-disponible', itemId: b.id } as never,
    ]);

    const tras = await leer(p.id);
    expect(r.vaABodega).toBe(true);
    expect(tras.estado).toBe(EstadoPedido.EN_REVISION);
    expect(tras.asignadoAId).toBeNull();
    // La línea que sube conserva las 5 que ya están en la bolsa (decisión 2): bodega
    // verifica solo las 3 de más.
    expect(tras.items[0]).toMatchObject({
      cantidad: 8,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 5,
      piezasBase: 5,
    });
    // La quitada ya la sacó el operador: el checklist de bodega no la repite.
    expect(tras.items[1]).toMatchObject({ cancelada: true, piezasRetiradas: 3 });
    expect(entradas(await reposicionDe(p.id))).toEqual([[b.id, 3]]);
  });
});

describe('REPONER: una línea que bodega no encontró vuelve al pedido', () => {
  it('vuelve PENDIENTE conservando lo pedido, recalcula el total y manda el pedido a bodega', async () => {
    const p = await crearPedido([
      { cantidad: 6, surtida: 6 },
      // Lo que deja `datosDeFaltaDeBodega()`: pidió 5, bodega no encontró nada.
      { cantidad: 5, surtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cancelada: true },
    ]);
    const [, b] = p.items;

    const r = await mostrador.ajustar(p.id, usuarioOp(), 'Ya llegó la talla', [
      { tipo: 'reponer', itemId: b.id, cantidad: 3 } as never,
    ]);

    const tras = await leer(p.id);
    expect(r.vaABodega).toBe(true);
    expect(tras.estado).toBe(EstadoPedido.EN_REVISION);
    expect(tras.asignadoAId).toBeNull();
    expect(tras.items[1]).toMatchObject({
      cancelada: false,
      cantidad: 3,
      // El "Pediste 5" sobrevive: reponer deshace la salida, no crea otra línea.
      cantidadPedida: 5,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 0,
      piezasRetiradas: 0,
    });
    expect(Number(tras.items[1].subtotal)).toBe(300);
    // 6 piezas que ya estaban + 3 repuestas.
    expect(Number(tras.subtotal)).toBe(900);
    // Reponer no saca nada de la bolsa.
    expect(await reposicionDe(p.id)).toBeNull();
  });

  it('rechaza reponer una línea que alguien quitó teniendo piezas apartadas', async () => {
    const p = await crearPedido([
      { cantidad: 6, surtida: 6 },
      { cantidad: 4, surtida: 4, cancelada: true },
    ]);

    await expect(
      mostrador.ajustar(p.id, usuarioOp(), 'La quiere de vuelta', [
        { tipo: 'reponer', itemId: p.items[1].id, cantidad: 2 } as never,
      ]),
    ).rejects.toThrow(/no se puede reponer/);
    // Nada cambió: la validación falla antes de tocar el pedido.
    expect((await leer(p.id)).estado).toBe(EstadoPedido.REVISADO);
  });
});

describe('delta-only (decisión 2): bodega verifica SOLO las piezas de más', () => {
  /** Mostrador sube la línea 1 de 3 a 5 y un bodeguero toma el pedido. */
  async function pedidoSubidoYTomado() {
    const p = await crearPedido([
      { cantidad: 3, surtida: 3 },
      { cantidad: 2, surtida: 2 },
    ]);
    await mostrador.ajustar(p.id, usuarioOp(), 'Quiere 5 en vez de 3', [
      { tipo: 'parcial', itemId: p.items[0].id, cantidad: 5 } as never,
    ]);
    await prisma.pedido.update({ where: { id: p.id }, data: { asignadoAId: bodegueroId } });
    return p;
  }

  it('la línea queda rebasada a lo que hay en la bolsa, con piso', async () => {
    const p = await pedidoSubidoYTomado();

    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.EN_REVISION);
    expect(tras.items[0]).toMatchObject({
      cantidad: 5,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      // Las 3 siguen dentro de la bolsa: bodega no las vuelve a contar.
      cantidadSurtida: 3,
      piezasBase: 3,
      piezasRetiradas: 0,
    });
    // La otra línea no se tocó.
    expect(tras.items[1]).toMatchObject({ piezasBase: 0, estadoSurtido: EstadoSurtido.COMPLETO });
  });

  it('"No hay" se rechaza: cancelaría una línea con 3 piezas dentro de la bolsa', async () => {
    const p = await pedidoSubidoYTomado();

    await expect(
      surtido.marcarItem(
        p.id,
        p.items[0].id,
        { cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE } as never,
        usuarioBodega(),
      ),
    ).rejects.toThrow(/dentro de la bolsa/);

    // Nada cambió en la BD.
    expect((await leer(p.id)).items[0]).toMatchObject({
      cancelada: false,
      cantidadSurtida: 3,
      estadoSurtido: EstadoSurtido.PENDIENTE,
    });
  });

  it('encuentra las 2 de más: COMPLETO con 5, y al cerrar el piso se limpia', async () => {
    const p = await pedidoSubidoYTomado();

    await surtido.marcarItem(
      p.id,
      p.items[0].id,
      { cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO } as never,
      usuarioBodega(),
    );
    const r = await surtido.confirmarSurtido(p.id, usuarioBodega(), false);

    expect(r.incompleto).toBe(false);
    const tras = await leer(p.id);
    expect(tras.estado).toBe(EstadoPedido.REVISADO);
    expect(tras.items[0]).toMatchObject({
      cantidad: 5,
      cantidadSurtida: 5,
      estadoSurtido: EstadoSurtido.COMPLETO,
      // El piso vive UNA ronda de surtido.
      piezasBase: 0,
    });
  });

  it('no encuentra ninguna de las 2: la línea se queda en 3 (no se cancela) y el cliente recibe una propuesta', async () => {
    const p = await pedidoSubidoYTomado();

    // "No hay más" = marcar el piso. Queda PARCIAL.
    await surtido.marcarItem(
      p.id,
      p.items[0].id,
      { cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL } as never,
      usuarioBodega(),
    );
    const r = await surtido.confirmarSurtido(p.id, usuarioBodega(), false);

    expect(r.incompleto).toBe(true);
    const tras = await leer(p.id);
    expect(tras.items[0]).toMatchObject({
      cancelada: false,
      cantidad: 3,
      cantidadSurtida: 3,
      estadoSurtido: EstadoSurtido.COMPLETO,
      piezasBase: 0,
    });
    // 3 + 2 piezas de $100.
    expect(Number(tras.subtotal)).toBe(500);
    const propuesta = await prisma.pedidoPropuesta.findFirst({ where: { pedidoId: p.id } });
    expect(propuesta?.creadaPorRol).toBe(RolUsuario.BODEGA);
  });
});
