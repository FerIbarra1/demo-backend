import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClienteService } from './cliente.service';
import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * F22 (oct 2026): el cliente puede avisar su llegada en CUALQUIER estado no
 * terminal de un pedido que se recoge en tienda.
 *
 * F16 lo limitaba a `REVISADO`, con el argumento de que "no hay nada que
 * mostrarle". Pero el cliente que llega temprano no tenía cómo decirlo (la app le
 * ocultaba el botón y el kiosko respondía 409), y el sistema YA dependía de ese
 * dato: bodega prioriza a los clientes presentes, y el destino de un surtido
 * incompleto (`destinoTrasSurtidoIncompleto`) decide si lo resuelve el mostrador o
 * el cliente en su app según haya o no aviso. Sin aviso anticipado esas dos
 * decisiones se tomaban a ciegas.
 *
 * Qué NO cambió: terminales y pedidos a domicilio siguen rechazándose.
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
    {} as never, // reposicion (F20),
    {} as never, // presencia (F22)
    {} as never, // sinRecoger (F22)
  );

  return { svc, confirmarDesdeCliente };
}

const pedidoBase = {
  id: 1,
  usuarioId: 7,
  estado: EstadoPedido.REVISADO,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  tiendaId: 5,
};

describe('anunciarLlegada — aviso anticipado (F22)', () => {
  it('acepta el aviso en REVISADO', async () => {
    const { svc, confirmarDesdeCliente } = crearServicio({ ...pedidoBase });
    await svc.anunciarLlegada(1, 7);
    expect(confirmarDesdeCliente).toHaveBeenCalledWith(1);
  });

  it.each([
    ['SOLICITADO', EstadoPedido.SOLICITADO],
    ['EN_REVISION', EstadoPedido.EN_REVISION],
    ['ESPERANDO_APROBACION', EstadoPedido.ESPERANDO_APROBACION],
    ['EN_ASESORIA', EstadoPedido.EN_ASESORIA],
    ['PENDIENTE_PAGO', EstadoPedido.PENDIENTE_PAGO],
    ['PAGADO', EstadoPedido.PAGADO],
    ['ENVIADO', EstadoPedido.ENVIADO],
  ])('acepta el aviso ANTICIPADO en %s', async (_nombre, estado) => {
    const { svc, confirmarDesdeCliente } = crearServicio({
      ...pedidoBase,
      estado,
    });
    await svc.anunciarLlegada(1, 7);
    expect(confirmarDesdeCliente).toHaveBeenCalledWith(1);
  });

  it.each([
    ['ENTREGADO', EstadoPedido.ENTREGADO],
    ['CANCELADO', EstadoPedido.CANCELADO],
  ])('rechaza el aviso en %s (terminal)', async (_nombre, estado) => {
    const { svc, confirmarDesdeCliente } = crearServicio({
      ...pedidoBase,
      estado,
    });
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(BadRequestException);
    // Lo importante: NO se llegó a escribir el aviso.
    expect(confirmarDesdeCliente).not.toHaveBeenCalled();
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
    // Oct 2026: el texto se unificó con el del kiosko y el de mostrador
    // (`pedidos/core/llegada-aviso.util.ts`). Antes este camino decía "no es
    // para recoger en tienda" y el kiosko "es a domicilio, no se recoge en
    // tienda" — dos textos para el mismo hecho.
    await expect(svc.anunciarLlegada(1, 7)).rejects.toThrow(/domicilio/i);
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
