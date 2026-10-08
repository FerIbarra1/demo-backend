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
      .mockResolvedValue(opts.pedido ?? { id: 1, estado: EstadoPedido.EN_ATENCION }),
  };

  // F17: `devolverACola` pasó de limpiar `llamadoAt` a mano a una transición
  // real (`EN_ATENCION → REVISADO`), así que ahora delega en la máquina de
  // estados. El mock captura la transición para poder aseverarla.
  const cambiarEstado = jest.fn().mockResolvedValue({ id: 1, estado: EstadoPedido.REVISADO });

  const svc = new MostradorService(
    prisma as never,
    { cambiarEstado } as never, // pedidoState
    access as never,
    {} as never, // reposicion
    { emitToTienda } as never,
    {} as never, // precios
    { confirmarDesdeMostrador } as never, // llegada
  );

  return {
    svc,
    update,
    historialCreate,
    emitToTienda,
    confirmarDesdeMostrador,
    access,
    cambiarEstado,
  };
}

describe('MostradorService.devolverACola', () => {
  it('devuelve el pedido a la plancha y avisa a la TV', async () => {
    const { svc, update, cambiarEstado, emitToTienda } = crearServicio({
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    const r = await svc.devolverACola(1, usuario);

    // F17: el deshacer es una transición real, no un update de `llamadoAt`.
    expect(cambiarEstado).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ nuevoEstado: EstadoPedido.REVISADO }),
      usuario,
      expect.objectContaining({ invalidarMonitor: true }),
    );
    // `llamadoAt` se limpia aparte: es auditoría de la llamada vigente.
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { llamadoAt: null },
    });
    expect(r).toEqual({ ok: true, pedidoId: 1 });
  });

  it('rechaza un pedido que nunca se llamó (sigue en la plancha)', async () => {
    // Sin esta guarda, "devolver a la cola" sería un no-op silencioso: el
    // operador creería que deshizo algo que nunca pasó.
    const { svc, cambiarEstado } = crearServicio({
      pedido: { id: 1, estado: EstadoPedido.REVISADO },
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    await expect(svc.devolverACola(1, usuario)).rejects.toThrow(BadRequestException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('rechaza un pedido que ya salió de mostrador', async () => {
    const { svc, cambiarEstado } = crearServicio({
      pedido: { id: 1, estado: EstadoPedido.PENDIENTE_PAGO },
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    await expect(svc.devolverACola(1, usuario)).rejects.toThrow(/PENDIENTE_PAGO/);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('valida el acceso antes de tocar nada', async () => {
    const { svc, access, cambiarEstado } = crearServicio({
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    await svc.devolverACola(1, usuario);

    expect(access.cargarYValidar).toHaveBeenCalledWith(1, usuario);
    expect(cambiarEstado).toHaveBeenCalled();
  });
});

/**
 * Oct 2026 — B4: el ajuste de mostrador REEMPLAZA la propuesta viva.
 *
 * El escenario: el pedido quedó incompleto con una propuesta PENDIENTE (bodega
 * reportó faltantes) y el operador ajusta el pedido enfrente. Si la propuesta se
 * queda PENDIENTE, bodega choca contra el índice único parcial
 * (`pedidos_propuestas_pendiente_unica_idx`) al cerrar el surtido de la
 * siguiente ronda, y `enviarAPagar` queda bloqueado para siempre por su guard
 * de propuesta pendiente.
 */
describe('MostradorService.ajustar — la propuesta huérfana', () => {
  function crearConAjuste() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const prisma: Record<string, any> = {
      pedido: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          estado: EstadoPedido.REVISADO,
          tiendaId: 5,
          descuento: 0,
          impuestos: 0,
          // El item que el ajuste va a tocar: `validarAjuste` exige que
          // pertenezca al pedido.
          items: [
            { id: 10, cantidad: 5, cantidadSurtida: 5, estadoSurtido: 'COMPLETO', cancelada: false },
          ],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      historialPedido: { create: jest.fn() },
      pedidoPropuesta: { updateMany },
      itemPedido: {
        findUnique: jest.fn().mockResolvedValue({ id: 10, precioUnitario: 100 }),
        update: jest.fn().mockResolvedValue({}),
        // `recalcularTotalesPedido` (que corre al final del ajuste) suma los
        // subtotales de los items activos, y `aplicarAjuste` pide los ids
        // actuales. Un item con `subtotal` es lo mínimo para que el recálculo
        // no reviente con un Decimal inválido.
        findMany: jest.fn().mockResolvedValue([{ id: 10, subtotal: 500 }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, opts: any) => {
      // Los efectos corren dentro de la transacción, igual que en producción.
      // El `tx` es el mismo objeto prisma: así las escrituras del ajuste
      // (`itemPedido`, `pedidoPropuesta`) quedan registradas en los mocks.
      if (opts?.efectos) await opts.efectos(prisma);
      return { id: 1, estado: EstadoPedido.EN_REVISION };
    });

    const svc = new MostradorService(
      prisma as never,
      { cambiarEstado } as never,
      { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado: EstadoPedido.REVISADO }) } as never,
      { crearDesdeAjuste: jest.fn() } as never,
      { emitToTienda: jest.fn() } as never,
      { columnaParaPedido: jest.fn(async () => 'lista1') } as never,
      {} as never,
    );

    return { svc, updateMany };
  }

  it('marca SUPERADA la propuesta pendiente antes de mandar el pedido a bodega', async () => {
    const { svc, updateMany } = crearConAjuste();

    await svc.ajustar(1, usuario, 'el cliente quiere 2 menos', [
      { itemId: 10, tipo: 'parcial', cantidad: 2 } as never,
    ]);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pedidoId: 1, estado: 'PENDIENTE' },
        data: expect.objectContaining({ estado: 'SUPERADA' }),
      }),
    );
  });

  it('también la marca SUPERADA cuando el ajuste NO trae items', async () => {
    // El caso que se escapó en la primera versión: los `efectos` estaban
    // condicionados a `hayCambios`, así que un ajuste sin items (el operador
    // solo describe lo que el cliente quiere) dejaba la propuesta PENDIENTE. El
    // pedido volvía a bodega con una propuesta viva y bodega chocaba contra el
    // índice único parcial al cerrar el surtido siguiente.
    const { svc, updateMany } = crearConAjuste();

    await svc.ajustar(1, usuario, 'el cliente quiere 2 menos');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pedidoId: 1, estado: 'PENDIENTE' },
        data: expect.objectContaining({ estado: 'SUPERADA' }),
      }),
    );
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

/**
 * Oct 2026: `traerAEntrega` — la salida que faltaba desde asesoría.
 *
 * `TRANSICIONES[EN_ASESORIA]` ya contemplaba `REVISADO`, pero ningún endpoint la
 * disparaba: el operador solo podía "avisar llegada", que registra la presencia
 * pero NO mete el pedido a la cola (el gate de visibilidad exige `REVISADO`).
 * Así que el cliente con un pedido en asesoría se quedaba de pie esperando algo
 * que nunca aparecía en la pantalla del mostrador.
 */
describe('MostradorService.traerAEntrega', () => {
  it('mueve el pedido de asesoría al área de entrega', async () => {
    const { svc, cambiarEstado } = crearServicio({
      pedido: { id: 1, estado: EstadoPedido.EN_ASESORIA },
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    const r = await svc.traerAEntrega(1, usuario, 'el cliente ya está aquí');

    expect(r.estado).toBe(EstadoPedido.REVISADO);
    expect(cambiarEstado).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ nuevoEstado: EstadoPedido.REVISADO }),
      usuario,
      // `asignacion: 'limpiar'` es obligatorio: el caller es el OPERADOR, y con
      // 'caller' el pedido quedaría asignado a un usuario de mostrador,
      // invisible en el monitor de bodega.
      expect.objectContaining({ asignacion: 'limpiar', invalidarMonitor: true }),
    );
  });

  it('rechaza un pedido que no está en asesoría', async () => {
    const { svc, cambiarEstado } = crearServicio({
      pedido: { id: 1, estado: EstadoPedido.REVISADO },
      completo: { numeroPedido: 'PD-2026-000123', tiendaId: 5 },
    });

    await expect(svc.traerAEntrega(1, usuario)).rejects.toThrow(BadRequestException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });
});
