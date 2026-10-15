import { EstadoPedido, EstadoSurtido, Prisma, RolUsuario } from '@prisma/client';
import { MostradorService } from './mostrador.service';
import type { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026: un AJUSTE de mostrador no genera lista de reposición.
 *
 * El reporte del piso:
 *
 *   "Si piden quitar 3 piezas de un producto, el bodeguero va al área de entrega,
 *    saca las 3 piezas y termina el ajuste. Ya no hay reposición porque ya la
 *    hizo en el ajuste. El problema es que, una vez completado, los productos
 *    que se quitaron y que ya puso en el anaquel vuelven a salir en reposición."
 *
 * El pedido sigue vivo y las piezas las saca el bodeguero con el checklist de
 * retiro. La reposición es SOLO de pedidos cancelados o rechazados.
 */

const usuario: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 10,
    cantidadSurtida: 10,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(1000),
    ...over,
  };
}

function crearServicio(items: any[]) {
  const pedidoCompleto = {
    id: 1,
    tiendaId: 5,
    estado: EstadoPedido.REVISADO,
    descuento: new Prisma.Decimal(0),
    impuestos: new Prisma.Decimal(0),
    items,
  };

  const tx = {
    pedido: { update: jest.fn(async () => ({})) },
    pedidoPropuesta: { updateMany: jest.fn(async () => ({ count: 0 })) },
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id) ?? null),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => items.filter((i) => !i.cancelada).length),
    },
  };

  const prisma = { pedido: { findUnique: jest.fn(async () => pedidoCompleto) } };

  const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, opts: any) => {
    // Los efectos corren dentro de la transición, igual que en producción.
    if (opts?.efectos) await opts.efectos(tx);
    return { id: 1, estado: EstadoPedido.EN_REVISION };
  });

  // Cualquier uso de la reposición durante un ajuste es un bug.
  const reposicion = {
    crearDesdePedido: jest.fn(),
    crearDesdeAjuste: jest.fn(),
  };

  const svc = new MostradorService(
    prisma as never,
    { cambiarEstado } as never,
    { cargarYValidar: jest.fn(async () => ({ id: 1, estado: EstadoPedido.REVISADO })) } as never,
    reposicion as never,
    { emitToTienda: jest.fn() } as never,
    { columnaParaPedido: jest.fn(async () => 'lista1') } as never,
    { confirmarDesdeMostrador: jest.fn(async () => ({})) } as never,
    {} as never, // presencia (F22)
    { resolverParaLlamar: jest.fn().mockResolvedValue(null) } as never, // mostradores (F22)
    { get: jest.fn() } as never, // config
  );

  return { svc, tx, reposicion };
}

describe('MostradorService.ajustar: no crea reposición', () => {
  it('quitar una línea con piezas apartadas NO genera reposición', async () => {
    const { svc, tx, reposicion } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Ya no quiere el primero', [
      { tipo: 'no-disponible', itemId: 1 } as never,
    ]);

    // El ajuste sí se aplicó: la línea quedó cancelada conservando el hallazgo
    // para que el checklist de retiro sepa cuánto sacar de la bolsa.
    const upd = (tx.itemPedido.update as jest.Mock).mock.calls.find(
      ([a]: any) => a.where.id === 1,
    )![0];
    expect(upd.data.cancelada).toBe(true);
    expect(upd.data.cantidadSurtida).toBe(10);

    expect(reposicion.crearDesdePedido).not.toHaveBeenCalled();
    expect(reposicion.crearDesdeAjuste).not.toHaveBeenCalled();
  });

  it('bajar la cantidad NO genera reposición: el sobrante lo saca el bodeguero', async () => {
    const { svc, tx, reposicion } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Solo quiere 7', [
      { tipo: 'parcial', itemId: 1, cantidad: 7 } as never,
    ]);

    const upd = (tx.itemPedido.update as jest.Mock).mock.calls[0][0];
    expect(upd.data.cantidad).toBe(7);
    // El hallazgo sobrevive: el checklist de retiro lo lee para saber que sobran 3.
    expect(upd.data.cantidadSurtida).toBe(10);

    expect(reposicion.crearDesdePedido).not.toHaveBeenCalled();
    expect(reposicion.crearDesdeAjuste).not.toHaveBeenCalled();
  });

  it('subir sobre lo que ya salió de la bolsa vuelve a bodega a re-verificar', async () => {
    // Había 5, ya salieron 2 (en la bolsa 3) y ahora el cliente quiere 4. Las 2
    // que salieron ya están en el anaquel: el item no puede quedar COMPLETO.
    const { svc, tx } = crearServicio([
      item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 }),
      item({ id: 2 }),
    ]);

    await svc.ajustar(1, usuario, 'Ahora quiere 4', [
      { tipo: 'parcial', itemId: 1, cantidad: 4 } as never,
    ]);

    const upd = (tx.itemPedido.update as jest.Mock).mock.calls[0][0];
    expect(upd.data.cantidad).toBe(4);
    expect(upd.data.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    expect(upd.data.cantidadSurtida).toBe(0);
    expect(upd.data.piezasRetiradas).toBe(0);
  });
});
