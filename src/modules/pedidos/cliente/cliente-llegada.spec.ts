import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClienteService } from './cliente.service';
import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * F16 (sep 2026): el aviso de llegada solo se acepta cuando el pedido YA ESTÁ
 * LISTO para revisarse en tienda (`EN_MOSTRADOR`).
 *
 * Ese estado es exactamente el punto en que bodega terminó de verificar (aprobó
 * el pedido tal cual), o el cliente aprobó las modificaciones que bodega o
 * ventas propusieron.
 *
 * Antes solo se rechazaban COMPLETED y CANCELLED, así que el cliente podía
 * avisar desde PENDING_REVIEW: el pedido quedaba marcado "EN TIENDA" antes de
 * que nadie lo hubiera surtido, y el mostrador no tenía nada que mostrarle.
 */

function crearServicio(pedido: Record<string, unknown> | null) {
  const confirmarDesdeCliente = jest.fn().mockResolvedValue({ ok: true });

  const prisma = {
    pedido: { findUnique: jest.fn().mockResolvedValue(pedido) },
  };

  const svc = new ClienteService(
    prisma as never,
    {} as never, // notifications
    {} as never, // realtime
    {} as never, // state
    {} as never, // storage
    {} as never, // kioskoService
    { confirmarDesdeCliente } as never, // kioskoLlegada
    {} as never, // precios
  );

  return { svc, confirmarDesdeCliente };
}

const pedidoBase = {
  id: 1,
  usuarioId: 7,
  estado: EstadoPedido.EN_MOSTRADOR,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  tiendaId: 5,
};

describe('anunciarLlegada — solo cuando el pedido está listo (F16)', () => {
  it('acepta el aviso en EN_MOSTRADOR (bodega aprobó, o el cliente aprobó cambios)', async () => {
    const { svc, confirmarDesdeCliente } = crearServicio({ ...pedidoBase });
    await svc.anunciarLlegada(1, 7);
    expect(confirmarDesdeCliente).toHaveBeenCalledWith(1);
  });

  it.each([
    ['PENDING_REVIEW', EstadoPedido.PENDING_REVIEW],
    ['REVIEWING', EstadoPedido.REVIEWING],
    ['WAITING_CUSTOMER_APPROVAL', EstadoPedido.WAITING_CUSTOMER_APPROVAL],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['PENDING_PAID', EstadoPedido.PENDING_PAID],
    ['PAID', EstadoPedido.PAID],
    ['SHIPPED', EstadoPedido.SHIPPED],
    ['COMPLETED', EstadoPedido.COMPLETED],
    ['CANCELLED', EstadoPedido.CANCELLED],
  ])('rechaza el aviso en %s', async (_nombre, estado) => {
    const { svc, confirmarDesdeCliente } = crearServicio({
      ...pedidoBase,
      estado,
    });
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(BadRequestException);
    // Lo importante: NO se llegó a escribir el aviso.
    expect(confirmarDesdeCliente).not.toHaveBeenCalled();
  });

  it('el mensaje explica por qué no se puede todavía', async () => {
    const { svc } = crearServicio({
      ...pedidoBase,
      estado: EstadoPedido.REVIEWING,
    });
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(/preparando tu pedido/i);
  });

  it('sigue rechazando un pedido que no es del usuario', async () => {
    const { svc } = crearServicio({ ...pedidoBase, usuarioId: 99 });
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(NotFoundException);
  });

  it('sigue rechazando un pedido a domicilio', async () => {
    const { svc } = crearServicio({
      ...pedidoBase,
      modoEntrega: ModoEntrega.DOMICILIO,
    });
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(/recoger en tienda/i);
  });

  it('acepta también un pedido de kiosko listo', async () => {
    const { svc, confirmarDesdeCliente } = crearServicio({
      ...pedidoBase,
      modoEntrega: ModoEntrega.KIOSKO,
    });
    await svc.anunciarLlegada(1, 7);
    expect(confirmarDesdeCliente).toHaveBeenCalled();
  });
});
