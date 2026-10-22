import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EstadoPedido, ModoEntrega, RolUsuario } from '@prisma/client';
import { CajeroService } from '../cajero/cajero.service';
import { BodegaService } from '../bodega/bodega.service';

/**
 * PLAN-ADMIN-MULTITIENDA §13 (F3.5, oct 2026): el ADMIN CUBRE UN PUESTO. Reemplaza a
 * `admin-no-retiene-pedidos.spec.ts`, que fijaba la decisión anterior (el ADMIN no toma pedidos, 403).
 *
 * Tomar un pedido lo ASIGNA a quien lo toma, y todo lo que rodea a una asignación asume que quien lo tiene
 * está en un puesto que alguien ve:
 *  - en caja, a SU ventanilla: sin ella el pedido quedaba asignado a un usuario invisible en la TV (solo lista a un
 *    cajero activo) y en la fila (solo lista los sin asignar). Por eso el ADMIN puede tomar SI ocupa una ventanilla
 *    EN LA TIENDA DEL PEDIDO — la de otra tienda no sirve;
 *  - en bodega, a su ficha: el monitor de TV, el cierre de sesión y el barrido de inactividad ya lo incluyen
 *    (ver `bodega-presencia-postgres.spec.ts`), así que tomar ya no tiene el bloqueo.
 *
 * Es el servicio —la frontera de confianza— quien lo exige: una pantalla desfasada o un cliente de la API no pueden
 * saltarse un botón deshabilitado. La parte contra la BD (qué fila se escribe de verdad) vive en
 * `admin-cubre-puesto-postgres.spec.ts`; aquí, las reglas y que NADIE más pague por ellas.
 */

const admin = {
  userId: 1,
  nombre: 'Fernando (Administrador)',
  rol: RolUsuario.ADMIN,
  tiendaId: undefined,
};
const cajero = { userId: 2, nombre: 'Ana', rol: RolUsuario.CAJERO, tiendaId: 5 };
const bodeguero = { userId: 3, nombre: 'Rosa', rol: RolUsuario.BODEGA, tiendaId: 5 };

/** Dependencia que EXPLOTA si alguien la toca. */
const intocable = (quien: string) =>
  new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`${quien}: se tocó "${String(p)}" donde no tocaba`);
      },
    },
  );

const pedidoEnCaja = (tiendaId: number) => ({
  id: 10,
  numeroPedido: 'PD-10',
  tiendaId,
  estado: EstadoPedido.PENDIENTE_PAGO,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  cajeroAsignadoId: null,
});

/** CajeroService con un Prisma de mentira: `leePedido` es lo que ve el ADMIN ANTES de la transacción. */
function crearCaja(opts: { pedido: ReturnType<typeof pedidoEnCaja> | null; ventanilla: unknown }) {
  const tx = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(opts.pedido),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(opts.pedido),
    },
    historialPedido: { create: jest.fn() },
  };
  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(opts.pedido && { tiendaId: opts.pedido.tiendaId }),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const ventanillas = { ventanillaDelCajero: jest.fn().mockResolvedValue(opts.ventanilla) };
  const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn() };
  const svc = new CajeroService(
    prisma as never,
    realtime as never,
    intocable('PedidoStateService') as never,
    ventanillas as never,
  );
  return { svc, prisma, tx, ventanillas, realtime };
}

describe('caja: el ADMIN toma pedidos SOLO si ocupa una ventanilla en la tienda del pedido', () => {
  it('sin ventanilla en esa tienda → 403 y no se escribe nada', async () => {
    const { svc, prisma, tx, ventanillas } = crearCaja({
      pedido: pedidoEnCaja(7),
      ventanilla: null,
    });

    await expect(svc.tomarPedidoCajero(10, admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.tomarPedidoCajero(10, admin)).rejects.toThrow(/ventanilla de esta tienda/i);

    // La pregunta es por la tienda del PEDIDO, no por la del token (el ADMIN no trae) ni por otra.
    expect(ventanillas.ventanillaDelCajero).toHaveBeenCalledWith(admin.userId, 7);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.pedido.updateMany).not.toHaveBeenCalled();
  });

  it('con una ventanilla en OTRA tienda tampoco: la consulta es por la tienda del pedido y ahí no tiene', async () => {
    // `ventanillaDelCajero(userId, tienda)` busca `{ tiendaId, cajeroId }`: la ventanilla de la tienda 5 no
    // contesta por la 7. El mock lo reproduce devolviendo algo solo para la tienda que sí tiene.
    const { svc, ventanillas, prisma } = crearCaja({ pedido: pedidoEnCaja(7), ventanilla: null });
    ventanillas.ventanillaDelCajero.mockImplementation(async (_u: number, t: number) =>
      t === 5 ? { id: 1, numero: 1 } : null,
    );

    await expect(svc.tomarPedidoCajero(10, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('con ventanilla en la tienda del pedido → lo toma: queda asignado al ADMIN y el nombre dice "(Administrador)"', async () => {
    const { svc, tx, realtime } = crearCaja({
      pedido: pedidoEnCaja(7),
      ventanilla: { id: 3, numero: 3 },
    });

    await svc.tomarPedidoCajero(10, admin);

    expect(tx.pedido.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cajeroAsignadoId: admin.userId }),
      }),
    );
    expect(tx.historialPedido.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        usuarioNombre: 'Fernando (Administrador)',
        observacion: expect.stringContaining('Fernando (Administrador)'),
      }),
    });
    // Realtime a la tienda del PEDIDO, después del commit.
    expect(realtime.emitToTienda).toHaveBeenCalledWith(
      7,
      'pedido.cajero-asignado',
      expect.anything(),
    );
  });

  it('un pedido que no existe es 404, no un 403 "elige una ventanilla" que nada tiene que ver', async () => {
    const { svc, ventanillas } = crearCaja({ pedido: null, ventanilla: null });
    await expect(svc.tomarPedidoCajero(999, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(ventanillas.ventanillaDelCajero).not.toHaveBeenCalled();
  });

  it('el CAJERO no paga nada de esto: ni lee el pedido por fuera ni pregunta por ventanilla (ya la exige EstacionGuard)', async () => {
    const { svc, prisma, ventanillas, tx } = crearCaja({
      pedido: pedidoEnCaja(5),
      ventanilla: null,
    });

    await svc.tomarPedidoCajero(10, cajero);

    expect(prisma.pedido.findUnique).not.toHaveBeenCalled();
    expect(ventanillas.ventanillaDelCajero).not.toHaveBeenCalled();
    expect(tx.pedido.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('caja: llamar al siguiente usa la tienda que el ADMIN opera, no la del token', () => {
  it('sin tienda resuelta → 400 (el controller siempre la manda; es la última defensa)', async () => {
    const { svc, ventanillas } = crearCaja({ pedido: null, ventanilla: null });
    await expect(svc.llamarSiguiente(admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(ventanillas.ventanillaDelCajero).not.toHaveBeenCalled();
  });

  it('sin ventanilla EN ESA tienda → 400, y la pregunta es por la tienda resuelta', async () => {
    const { svc, ventanillas } = crearCaja({ pedido: null, ventanilla: null });

    await expect(svc.llamarSiguiente(admin, 7)).rejects.toThrow(/elegir una ventanilla/i);

    expect(ventanillas.ventanillaDelCajero).toHaveBeenCalledWith(admin.userId, 7);
  });

  it('el CAJERO sin pasar tienda sigue usando la suya (el default es la del token)', async () => {
    const { svc, ventanillas } = crearCaja({ pedido: null, ventanilla: null });
    await expect(svc.llamarSiguiente(cajero)).rejects.toBeInstanceOf(BadRequestException);
    expect(ventanillas.ventanillaDelCajero).toHaveBeenCalledWith(cajero.userId, 5);
  });
});

describe('bodega: el ADMIN ya no tiene el 403 de tomar', () => {
  const pedidoSolicitado = {
    id: 10,
    tiendaId: 7,
    estado: EstadoPedido.SOLICITADO,
    asignadoAId: null,
  };

  function crearBodega() {
    const access = { cargarYValidar: jest.fn().mockResolvedValue(pedidoSolicitado) };
    const state = { cambiarEstado: jest.fn().mockResolvedValue({ id: 10 }) };
    const realtime = { emitToTienda: jest.fn() };
    const svc = new BodegaService(
      intocable('PrismaService') as never,
      realtime as never,
      state as never,
      access as never,
    );
    return { svc, access, state, realtime };
  }

  it('tomarPedido: lo toma con SU identidad, sin tienda en el token (cargarYValidar exime al ADMIN)', async () => {
    const { svc, access, state, realtime } = crearBodega();

    await svc.tomarPedido(10, admin);

    expect(access.cargarYValidar).toHaveBeenCalledWith(10, admin);
    expect(state.cambiarEstado).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ nuevoEstado: EstadoPedido.EN_REVISION }),
      admin,
      expect.objectContaining({ asignacion: 'caller' }),
    );
    // El aviso va a la tienda del PEDIDO: el ADMIN no tiene una propia a la que avisar.
    expect(realtime.emitToTienda).toHaveBeenCalledWith(7, 'pedido.asignado', {
      id: 10,
      asignadoAId: admin.userId,
      asignadoANombre: 'Fernando (Administrador)',
    });
  });

  it('el bodeguero lo toma igual que antes', async () => {
    const { svc, state } = crearBodega();
    await svc.tomarPedido(10, bodeguero);
    expect(state.cambiarEstado).toHaveBeenCalledWith(
      10,
      expect.anything(),
      bodeguero,
      expect.objectContaining({ asignacion: 'caller' }),
    );
  });

  it('tomarGrupo: valida la lista antes que nada (la misma regla que para el bodeguero)', async () => {
    const { svc } = crearBodega();
    await expect(svc.tomarGrupo([], admin, 7)).rejects.toBeInstanceOf(BadRequestException);
  });
});
