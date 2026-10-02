import { BadRequestException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { MostradorService } from './mostrador.service';
import type { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026: dos acciones nuevas de la consola de mostrador.
 *
 *   1. `marcarLlegada` — el operador activa la llegada EN NOMBRE del cliente.
 *      El caso que lo motiva: hay clientes que llegan a tienda y van directo al
 *      mostrador, sin teléfono a la mano o sin el folio. Con el gate de D5 su
 *      pedido web está OCULTO de la cola hasta que alguien avisa, así que sin
 *      esta acción el pedido quedaba atrapado aunque el cliente estuviera
 *      enfrente.
 *
 *   2. `devolverACola` — deshace un "Llamar por la TV". En cajero, tomar un
 *      pedido se puede deshacer; en mostrador no había vuelta atrás, así que un
 *      folio mal llamado quedaba anunciado en la pantalla y el correcto ya no
 *      estaba en la lista de espera.
 */

const usuario: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

function crearServicio(opts: {
  pedido?: Record<string, unknown>;
  completo?: Record<string, unknown> | null;
}) {
  const update = jest.fn().mockResolvedValue({});
  const historialCreate = jest.fn().mockResolvedValue({});
  const emitToTienda = jest.fn();
  const confirmarDesdeMostrador = jest.fn().mockResolvedValue({
    ok: true,
    pedidoId: 1,
    reanudado: true,
    esperandoDesdeMin: 0,
  });

  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(opts.completo ?? null),
      update,
    },
    historialPedido: { create: historialCreate },
  };

  const access = {
    cargarYValidar: jest
      .fn()
      .mockResolvedValue(opts.pedido ?? { id: 1, estado: EstadoPedido.EN_MOSTRADOR }),
  };

  const svc = new MostradorService(
    prisma as never,
    {} as never, // pedidoState
    access as never,
    {} as never, // reposicion
    { emitToTienda } as never,
    {} as never, // precios
    { confirmarDesdeMostrador } as never, // llegada
  );

  return { svc, update, historialCreate, emitToTienda, confirmarDesdeMostrador, access };
}

describe('MostradorService.devolverACola', () => {
  it('saca el folio del panel Atendiendo y avisa a la TV', async () => {
    const { svc, update, historialCreate, emitToTienda } = crearServicio({
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5, llamadoAt: new Date() },
    });

    const r = await svc.devolverACola(1, usuario);

    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { llamadoAt: null },
    });
    // El historial deja constancia sin cambiar de estado.
    expect(historialCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pedidoId: 1,
        estadoAnterior: EstadoPedido.EN_MOSTRADOR,
        estadoNuevo: EstadoPedido.EN_MOSTRADOR,
        observacion: expect.stringContaining('Devuelto a la cola por Ana Mostrador'),
      }),
    });
    // Sin esto el folio seguiría anunciado en la TV hasta el siguiente poll.
    expect(emitToTienda).toHaveBeenCalledWith(5, 'monitor.invalidado', { pedidoId: 1 });
    expect(r).toEqual({ ok: true, pedidoId: 1 });
  });

  it('rechaza un pedido que no está en el panel Atendiendo', async () => {
    // Sin esta guarda, "devolver a la cola" sería un no-op silencioso: el
    // operador creería que deshizo algo que nunca pasó.
    const { svc, update } = crearServicio({
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5, llamadoAt: null },
    });

    await expect(svc.devolverACola(1, usuario)).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('rechaza un pedido que ya salió de EN_MOSTRADOR', async () => {
    const { svc, update } = crearServicio({
      pedido: { id: 1, estado: EstadoPedido.PENDING_PAID },
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5, llamadoAt: new Date() },
    });

    await expect(svc.devolverACola(1, usuario)).rejects.toThrow(/EN_MOSTRADOR/);
    expect(update).not.toHaveBeenCalled();
  });

  it('valida el acceso antes de tocar nada', async () => {
    const { svc, access, update } = crearServicio({
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5, llamadoAt: new Date() },
    });

    await svc.devolverACola(1, usuario);

    expect(access.cargarYValidar).toHaveBeenCalledWith(1, usuario);
    expect(update).toHaveBeenCalled();
  });
});

describe('MostradorService.marcarLlegada', () => {
  it('valida el acceso y delega en el servicio de llegada', async () => {
    // La validación de tienda/rol vive aquí y no en KioskoLlegadaService:
    // KioskoModule no puede importar PedidosModule (sería un ciclo).
    const { svc, access, confirmarDesdeMostrador } = crearServicio({});

    await svc.marcarLlegada(1, usuario);

    expect(access.cargarYValidar).toHaveBeenCalledWith(1, usuario);
    expect(confirmarDesdeMostrador).toHaveBeenCalledWith(1, usuario);
  });

  it('no toca el pedido si el acceso falla', async () => {
    const { svc, access, confirmarDesdeMostrador } = crearServicio({});
    access.cargarYValidar.mockRejectedValue(new BadRequestException('Otra tienda'));

    await expect(svc.marcarLlegada(1, usuario)).rejects.toThrow(BadRequestException);
    expect(confirmarDesdeMostrador).not.toHaveBeenCalled();
  });
});
