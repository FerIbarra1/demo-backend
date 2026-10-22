import 'dotenv/config';
import {
  EstadoPedido,
  EstadoTareaErp,
  ModoEntrega,
  PrismaClient,
  TipoTareaErp,
} from '@prisma/client';
import { PedidoAccessService } from '../pedidos/core/pedido-access.service';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { AdminService } from '../pedidos/admin/admin.service';
import { abrirTareaErp } from '../pedidos/core/tareas-erp.util';
import { ExternalRefService } from './external-ref.service';
import { PedidoPagoHandler } from './handlers/pedido-pago.handler';
import { ConciliacionService } from './conciliacion.service';

/**
 * Oct 2026 contra PostgreSQL REAL: la conciliación activa. Dos tiendas, para comprobar que lo de una no toca a la otra.
 *
 * Lo que se fija: la nube corrige SOLA el cobro y la cancelación del Sistema Comercial que no supo (por el handler de
 * siempre, con su correo y su historial), NO toca lo que es dinero sin respuesta obvia (cobrado y cancelado, cobro
 * desmarcado), el hallazgo abierto se refresca sin duplicarse y se cierra solo cuando el problema desaparece, y las
 * tareas del Sistema Comercial que el ERP ya cumplió se cierran.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const realtime = {
  emitToTienda: jest.fn(),
  emitToPedido: jest.fn(),
  emitToUser: jest.fn(),
  emitToTesoreria: jest.fn(),
};
const notifications = {
  enviar: jest.fn().mockResolvedValue(undefined),
  enviarTransferencia: jest.fn(),
};

let tiendaA: number;
let tiendaB: number;
let extA: number;
let extB: number;
let clienteId: number;
const pedidoIds: number[] = [];
let n = 0;

let conciliacion: ConciliacionService;

const idErp = (pedidoId: number) => 1_000_000_000 + pedidoId;

async function pedido(
  estado: EstadoPedido,
  o: { tienda?: number; total?: number; envio?: string; cancelado?: boolean } = {},
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-CO${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId: o.tienda ?? tiendaA,
      estado,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'Cliente CO',
      clienteEmail: `co-${suffix}-${n}@test.local`,
      subtotal: o.total ?? 100,
      total: o.total ?? 100,
    },
  });
  await prisma.pedidoPendienteEnvio.create({
    data: {
      pedidoId: p.id,
      estado: o.envio ?? 'PROCESADO',
      externalIdPEDIDOS: idErp(p.id),
      externalFolio: String(p.id).padStart(10, '0'),
    },
  });
  if (o.cancelado) {
    await prisma.historialPedido.create({
      data: {
        pedidoId: p.id,
        estadoAnterior: EstadoPedido.PENDIENTE_PAGO,
        estadoNuevo: EstadoPedido.CANCELADO,
      },
    });
  }
  pedidoIds.push(p.id);
  return p;
}

const erp = (
  p: { id: number },
  o: Partial<{
    existe: boolean;
    swcancel: boolean;
    finalizada: boolean;
    total: number | null;
  }> = {},
) => ({
  externalIdPEDIDOS: idErp(p.id),
  existe: true,
  swcancel: false,
  finalizada: false,
  total: 100,
  ...o,
});
const correr = (tienda: number, ...pedidos: ReturnType<typeof erp>[]) =>
  conciliacion.aplicar({ tiendaId: tienda, pedidos });
const estadoDe = async (id: number) =>
  (await prisma.pedido.findUniqueOrThrow({ where: { id } })).estado;
const hallazgos = (pedidoId: number) =>
  prisma.conciliacionHallazgo.findMany({ where: { pedidoId }, orderBy: { id: 'asc' } });
const tareasDe = (pedidoId: number) =>
  prisma.tareaSistemaComercial.findMany({ where: { pedidoId } });

beforeAll(async () => {
  const mk = async (x: string, ext: number) =>
    prisma.tienda.create({
      data: {
        nombre: `Concil ${x} ${suffix}`,
        direccion: 'x',
        ciudad: x,
        estado: 'x',
        externalId: ext,
      },
    });
  extA = Number(`7${suffix}`);
  extB = Number(`8${suffix}`);
  tiendaA = (await mk('A', extA)).id;
  tiendaB = (await mk('B', extB)).id;
  clienteId = (
    await prisma.usuario.create({
      data: { email: `co-${suffix}@test.local`, password: 'x', nombre: 'C', rol: 'CLIENTE' },
    })
  ).id;

  const access = new PedidoAccessService(prisma as never);
  const state = new PedidoStateService(
    prisma as never,
    notifications as never,
    realtime as never,
    access,
    { resolverImagen: (x: unknown) => x } as never,
  );
  const admin = new AdminService(
    prisma as never,
    notifications as never,
    realtime as never,
    access,
    state,
  );
  const handler = new PedidoPagoHandler(
    prisma as never,
    new ExternalRefService(prisma as never),
    admin,
    state,
    realtime as never,
  );
  conciliacion = new ConciliacionService(prisma as never, handler);
});

afterAll(async () => {
  await prisma.tareaSistemaComercial.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.conciliacionHallazgo.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.syncCheckpoint.deleteMany({ where: { tiendaId: { in: [tiendaA, tiendaB] } } });
  await prisma.historialPedido.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedidoReposicion.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedidoPendienteEnvio.deleteMany({ where: { pedidoId: { in: pedidoIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.usuario.deleteMany({ where: { id: clienteId } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaA, tiendaB] } } });
  await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe('pendientes — qué pedidos conviene verificar', () => {
  it('solo los que YA viven en el Sistema Comercial y pueden diverger, de ESA tienda, paginados', async () => {
    const pagar = await pedido(EstadoPedido.PENDIENTE_PAGO);
    const pagado = await pedido(EstadoPedido.PAGADO);
    const enviado = await pedido(EstadoPedido.ENVIADO);
    const entregado = await pedido(EstadoPedido.ENTREGADO);
    const sinEntregarAlErp = await pedido(EstadoPedido.PENDIENTE_PAGO, { envio: 'PENDIENTE' });
    const antes = await pedido(EstadoPedido.REVISADO);
    const deOtra = await pedido(EstadoPedido.PENDIENTE_PAGO, { tienda: tiendaB });
    const cancelReciente = await pedido(EstadoPedido.CANCELADO, { cancelado: true });
    const cancelViejo = await pedido(EstadoPedido.CANCELADO); // sin historial reciente de cancelación
    const cancelConTarea = await pedido(EstadoPedido.CANCELADO);
    await abrirTareaErp(prisma as never, {
      pedidoId: cancelConTarea.id,
      tiendaId: tiendaA,
      tipo: TipoTareaErp.CANCELAR_EN_ERP,
      motivo: 'x',
      actor: { id: 1, rol: 'GERENTE', nombre: 'G' },
    });

    const r = await conciliacion.pendientes(extA, 500, 0);
    const ids = r.pedidos.map((p) => p.pedidoId);
    expect(ids).toEqual(
      expect.arrayContaining([
        pagar.id,
        pagado.id,
        enviado.id,
        cancelReciente.id,
        cancelConTarea.id,
      ]),
    );
    for (const fuera of [entregado, sinEntregarAlErp, antes, deOtra, cancelViejo]) {
      expect(ids).not.toContain(fuera.id);
    }
    expect(r.pedidos.find((p) => p.pedidoId === pagar.id)!.externalIdPEDIDOS).toBe(idErp(pagar.id));

    // Paginado: de uno en uno, sin repetir, hasta agotar.
    const vistos: number[] = [];
    let despues = 0;
    for (let i = 0; i < 20; i++) {
      const pag = await conciliacion.pendientes(extA, 1, despues);
      vistos.push(...pag.pedidos.map((p) => p.pedidoId));
      if (pag.siguiente == null) break;
      despues = pag.siguiente;
    }
    expect(vistos).toEqual(ids);
  });
});

describe('aplicar — lo que la nube corrige sola', () => {
  it('COBRO_PERDIDO: cobrado en el ERP y por pagar en la nube → PAGADO por el handler de siempre, con su constancia', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO);
    const r = await correr(extA, erp(p, { finalizada: true, idfactura: 77 } as never));

    expect(r).toMatchObject({ revisados: 1, curados: 1, hallazgosAbiertos: 0 });
    expect(await estadoDe(p.id)).toBe(EstadoPedido.PAGADO);
    // El mismo camino que el evento: correo de "pago confirmado" e historial.
    expect(notifications.enviar).toHaveBeenCalled();
    const h = await hallazgos(p.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ tipo: 'COBRO_PERDIDO', curado: true });
    expect(h[0].resueltoAt).not.toBeNull();
    // Y a la siguiente pasada ya no hay nada que decir.
    expect(await correr(extA, erp(p, { finalizada: true }))).toMatchObject({ curados: 0 });
    expect(await hallazgos(p.id)).toHaveLength(1);
  });

  it('CANCELACION_PERDIDA: cancelado en el ERP y vivo en la nube → CANCELADO', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO);
    await correr(extA, erp(p, { swcancel: true, total: 0 }));
    expect(await estadoDe(p.id)).toBe(EstadoPedido.CANCELADO);
    expect((await hallazgos(p.id))[0]).toMatchObject({ tipo: 'CANCELACION_PERDIDA', curado: true });
  });

  it('si el handler se niega, NO se fuerza: queda ESTADO_DISTINTO abierto y sin constancia de "curado"', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO);
    const negado = new ConciliacionService(
      prisma as never,
      {
        procesar: jest.fn().mockResolvedValue({ ok: false, mensaje: 'Transición no permitida' }),
      } as never,
    );
    const r = await negado.aplicar({ tiendaId: extA, pedidos: [erp(p, { finalizada: true })] });
    expect(r).toMatchObject({ curados: 0, hallazgosAbiertos: 1 });
    expect(await estadoDe(p.id)).toBe(EstadoPedido.PENDIENTE_PAGO);
    const h = await hallazgos(p.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ tipo: 'ESTADO_DISTINTO', curado: false, resueltoAt: null });
  });
});

describe('aplicar — dinero sin respuesta obvia: se VE, no se toca', () => {
  it('COBRADO_Y_CANCELADO: queda abierto, se refresca sin duplicarse y se cierra solo cuando desaparece', async () => {
    const p = await pedido(EstadoPedido.CANCELADO, { cancelado: true });

    await correr(extA, erp(p, { finalizada: true }));
    expect(await estadoDe(p.id)).toBe(EstadoPedido.CANCELADO);
    let h = await hallazgos(p.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ tipo: 'COBRADO_Y_CANCELADO', curado: false, resueltoAt: null });
    const primera = h[0].ultimaVezAt;

    await new Promise((r) => setTimeout(r, 15));
    await correr(extA, erp(p, { finalizada: true }));
    h = await hallazgos(p.id);
    expect(h).toHaveLength(1); // el índice único parcial + el refresco: una sola fila abierta
    expect(h[0].ultimaVezAt.getTime()).toBeGreaterThan(primera.getTime());

    // Alguien lo resolvió en el ERP (lo canceló de verdad): el siguiente ciclo lo cierra.
    await correr(extA, erp(p, { swcancel: true, total: 0 }));
    h = await hallazgos(p.id);
    expect(h[0].resueltoAt).not.toBeNull();
  });

  it('REVERSA_DE_COBRO: pagado en la nube, sin cobro en el ERP y sin tarea que lo explique', async () => {
    const p = await pedido(EstadoPedido.PAGADO);
    await correr(extA, erp(p));
    expect(await estadoDe(p.id)).toBe(EstadoPedido.PAGADO);
    expect((await hallazgos(p.id))[0]).toMatchObject({
      tipo: 'REVERSA_DE_COBRO',
      resueltoAt: null,
    });
  });

  it('con la tarea "registrar el cobro" abierta (cobro a mano) NO es reversa: es lo esperado', async () => {
    const p = await pedido(EstadoPedido.PAGADO);
    await abrirTareaErp(prisma as never, {
      pedidoId: p.id,
      tiendaId: tiendaA,
      tipo: TipoTareaErp.REGISTRAR_COBRO_EN_ERP,
      motivo: 'x',
      actor: { id: 1, rol: 'GERENTE', nombre: 'G' },
    });
    await correr(extA, erp(p));
    expect(await hallazgos(p.id)).toHaveLength(0);
  });

  it('TOTAL_DISTINTO lleva los dos montos; NO_EXISTE_EN_ERP cuando la fila ya no está', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO, { total: 100 });
    await correr(extA, erp(p, { total: 250 }));
    const h = await hallazgos(p.id);
    expect(h[0]).toMatchObject({
      tipo: 'TOTAL_DISTINTO',
      detalle: { totalNube: 100, totalErp: 250 },
    });

    const q = await pedido(EstadoPedido.PENDIENTE_PAGO);
    await correr(extA, erp(q, { existe: false, total: null }));
    expect((await hallazgos(q.id))[0]).toMatchObject({
      tipo: 'NO_EXISTE_EN_ERP',
      resueltoAt: null,
    });
  });
});

describe('aplicar — tareas del Sistema Comercial que el ERP ya cumplió', () => {
  const tarea = (p: { id: number }, tipo: TipoTareaErp) =>
    abrirTareaErp(prisma as never, {
      pedidoId: p.id,
      tiendaId: tiendaA,
      tipo,
      motivo: 'x',
      actor: { id: 1, rol: 'GERENTE', nombre: 'G' },
    });

  it('cobro registrado allá → la tarea "registrar el cobro" queda HECHA por el ERP', async () => {
    const p = await pedido(EstadoPedido.PAGADO);
    await tarea(p, TipoTareaErp.REGISTRAR_COBRO_EN_ERP);
    const r = await correr(extA, erp(p, { finalizada: true }));
    expect(r.tareasCerradas).toBe(1);
    expect((await tareasDe(p.id))[0]).toMatchObject({
      estado: EstadoTareaErp.HECHA,
      resueltaVia: 'ERP',
    });
  });

  it('cancelado allá → la tarea "cancelar en el ERP" se cierra; "anular la venta" NO (el dinero no se deduce)', async () => {
    const a = await pedido(EstadoPedido.CANCELADO);
    await tarea(a, TipoTareaErp.CANCELAR_EN_ERP);
    await correr(extA, erp(a, { swcancel: true, total: 0 }));
    expect((await tareasDe(a.id))[0].estado).toBe(EstadoTareaErp.HECHA);

    const b = await pedido(EstadoPedido.CANCELADO);
    await tarea(b, TipoTareaErp.ANULAR_VENTA_EN_ERP);
    await correr(extA, erp(b, { swcancel: true, total: 0 }));
    expect((await tareasDe(b.id))[0].estado).toBe(EstadoTareaErp.PENDIENTE);
  });
});

describe('aplicar — aislamiento y registro', () => {
  it('un IDPEDIDO de OTRA tienda (o que la nube no conoce) no se toca y se cuenta aparte', async () => {
    const ajeno = await pedido(EstadoPedido.PENDIENTE_PAGO, { tienda: tiendaB });
    const r = await correr(extA, erp(ajeno, { finalizada: true }), {
      ...erp({ id: 999_999_999 }),
      externalIdPEDIDOS: 2_000_000_001,
    });
    expect(r).toMatchObject({ revisados: 0, desconocidos: 2, curados: 0 });
    expect(await estadoDe(ajeno.id)).toBe(EstadoPedido.PENDIENTE_PAGO);
  });

  it('deja anotado cuándo se comparó y cuántos se revisaron (la salud distingue "sin diferencias" de "nadie comparó")', async () => {
    const p = await pedido(EstadoPedido.PENDIENTE_PAGO);
    const antes = Date.now();
    await correr(extB, erp(p)); // otra tienda: 0 revisados
    await correr(extA, erp(p, { total: 100 }));
    const cp = await prisma.syncCheckpoint.findUniqueOrThrow({ where: { tiendaId: tiendaA } });
    expect(cp.ultimaConciliacionAt!.getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(cp.ultimaConciliacionRevisados).toBe(1);
    const cpB = await prisma.syncCheckpoint.findUniqueOrThrow({ where: { tiendaId: tiendaB } });
    expect(cpB.ultimaConciliacionRevisados).toBe(0);
  });
});
