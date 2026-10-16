import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { ClienteService } from './cliente.service';

/**
 * F20 (oct 2026): el cliente cancela su propio pedido.
 *
 * Dos bugs que esto fija:
 *
 * 1. NO validaba el estado: el cliente podía cancelar un pedido ya PAGADO,
 *    porque `TRANSICIONES[PAGADO]` incluye CANCELADO. Ese arco existe para
 *    Firebird (SWCANCEL) y NO se toca — la web se adecúa al ERP. El límite va
 *    en el camino del cliente.
 *
 * 2. NO creaba la lista de reposición: la mercancía que bodega había apartado
 *    se quedaba sin que nadie la devolviera al anaquel.
 */

const usuario = {
  userId: 100,
  rol: RolUsuario.CLIENTE,
  tiendaId: 5,
  nombre: 'Cliente',
};

function crearServicio(
  estado: EstadoPedido | null,
  opts: {
    pedidoExiste?: boolean;
    /** El bodeguero que lo tiene asignado (solo importa en EN_REVISION). */
    asignadoAId?: number | null;
    /** Si el historial muestra que alguna vez se cerró un surtido. */
    cerroSurtidoAntes?: boolean;
    /** Oct 2026: una transferencia que impide cancelar (comprobante en revisión o verificada). */
    pagoEnCurso?: { id: number; estado: string } | null;
  } = {},
) {
  const crearDesdePedido = jest.fn().mockResolvedValue(undefined);
  const cambiarEstado = jest.fn().mockResolvedValue({ id: 1, estado: EstadoPedido.CANCELADO });

  const prisma = {
    pedido: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.pedidoExiste === false || estado === null
            ? null
            : { estado, asignadoAId: opts.asignadoAId ?? null },
        ),
    },
    historialPedido: {
      findFirst: jest.fn().mockResolvedValue(opts.cerroSurtidoAntes ? { id: 9 } : null),
    },
    // Oct 2026: antes de cancelar se pregunta si hay una transferencia que lo impida (aquí: no).
    pedidoPagoTransferencia: {
      findFirst: jest.fn().mockResolvedValue(opts.pagoEnCurso ?? null),
    },
  };

  const svc = new ClienteService(
    prisma as never,
    {} as never, // notifications
    {} as never, // realtime
    { cambiarEstado } as never, // state
    {} as never, // storage
    {} as never, // kioskoService
    {} as never, // kioskoLlegada
    {} as never, // precios
    { crearDesdePedido } as never, // reposicion,
    {} as never, // presencia (F22)
    {} as never, // sinRecoger (F22)
  );

  return { svc, cambiarEstado, crearDesdePedido, prisma };
}

describe('F20 — el cliente NO puede cancelar un pedido ya pagado', () => {
  it.each([[EstadoPedido.PAGADO], [EstadoPedido.ENVIADO], [EstadoPedido.ENTREGADO]])(
    'rechaza cancelar desde %s',
    async (estado) => {
      const { svc, cambiarEstado, crearDesdePedido } = crearServicio(estado);

      await expect(svc.cancelarPedido(1, usuario.userId, usuario)).rejects.toThrow(
        BadRequestException,
      );

      // Y no se movió nada: ni la transición ni la reposición.
      expect(cambiarEstado).not.toHaveBeenCalled();
      expect(crearDesdePedido).not.toHaveBeenCalled();
    },
  );

  it('el mensaje explica por qué y manda a mostrador', async () => {
    const { svc } = crearServicio(EstadoPedido.PAGADO);
    await expect(svc.cancelarPedido(1, usuario.userId, usuario)).rejects.toThrow(/ya fue pagado/i);
  });

  it('un pedido ya ENTREGADO tampoco se cancela', async () => {
    const { svc } = crearServicio(EstadoPedido.ENTREGADO);
    await expect(svc.cancelarPedido(1, usuario.userId, usuario)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('F20 — el cliente SÍ puede cancelar antes del cobro', () => {
  it.each([
    [EstadoPedido.SOLICITADO],
    [EstadoPedido.EN_REVISION],
    [EstadoPedido.REVISADO],
    [EstadoPedido.EN_ATENCION],
    [EstadoPedido.ESPERANDO_APROBACION],
    [EstadoPedido.EN_ASESORIA],
    [EstadoPedido.PENDIENTE_PAGO],
  ])('permite cancelar desde %s', async (estado) => {
    const { svc, cambiarEstado } = crearServicio(estado);

    await svc.cancelarPedido(1, usuario.userId, usuario);

    expect(cambiarEstado).toHaveBeenCalledTimes(1);
    const [, dto] = cambiarEstado.mock.calls[0];
    expect(dto.nuevoEstado).toBe(EstadoPedido.CANCELADO);
  });

  it('PENDIENTE_PAGO entra: el cobro todavía no ocurrió', async () => {
    // El encolado a Firebird pasa al entrar a PENDIENTE_PAGO, pero el cobro es
    // en VFP. Hasta que no esté PAGADO, el cliente puede arrepentirse.
    const { svc } = crearServicio(EstadoPedido.PENDIENTE_PAGO);
    await expect(svc.cancelarPedido(1, usuario.userId, usuario)).resolves.toBeDefined();
  });
});

describe('F20 — la cancelación del cliente crea la lista de reposición', () => {
  it('llama a crearDesdePedido con el motivo', async () => {
    const { svc, cambiarEstado, crearDesdePedido } = crearServicio(EstadoPedido.REVISADO);

    await svc.cancelarPedido(1, usuario.userId, usuario);

    // Los `efectos` los ejecuta la máquina de estados DENTRO de su transacción
    // (ver `pedido-state.service.ts`), así que el mock no los corre solo: hay
    // que invocarlos para probar lo que hacen.
    const [, , , opts] = cambiarEstado.mock.calls[0];
    await opts.efectos({} as never);

    expect(crearDesdePedido).toHaveBeenCalledTimes(1);
    const [, pedidoId, motivo] = crearDesdePedido.mock.calls[0];
    expect(pedidoId).toBe(1);
    expect(motivo).toMatch(/cliente/i);
  });

  it('la reposición corre DENTRO de los efectos de la transición', async () => {
    // Si el pedido se cancela pero la lista falla, quedaría mercancía apartada
    // sin nadie que la devuelva. Por eso va en los efectos, no después.
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);

    await svc.cancelarPedido(1, usuario.userId, usuario);

    const [, , , opts] = cambiarEstado.mock.calls[0];
    expect(typeof opts.efectos).toBe('function');
  });

  it('el pedido se libera y el reloj se detiene', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);

    await svc.cancelarPedido(1, usuario.userId, usuario);

    const [, , , opts] = cambiarEstado.mock.calls[0];
    expect(opts.asignacion).toBe('limpiar');
    expect(opts.reloj).toBe('detener');
  });
});

describe('F20 — pedido inexistente', () => {
  it('lanza NotFound', async () => {
    const { svc } = crearServicio(null);
    await expect(svc.cancelarPedido(999, usuario.userId, usuario)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('oct 2026 — la cancelación solo genera lista si la bolsa salió de las manos de bodega', () => {
  /** Corre los `efectos` de la transición y devuelve las opciones que recibió la reposición. */
  async function cancelar(
    estado: EstadoPedido,
    opts: { asignadoAId?: number | null; cerroSurtidoAntes?: boolean } = {},
  ) {
    const { svc, cambiarEstado, crearDesdePedido, prisma } = crearServicio(estado, opts);
    await svc.cancelarPedido(1, usuario.userId, usuario);
    const [, , , o] = cambiarEstado.mock.calls[0];
    await o.efectos({} as never);
    return { opciones: crearDesdePedido.mock.calls[0][3], prisma };
  }

  it('SOLICITADO: nadie ha tocado el anaquel, no hay nada que listar', async () => {
    const { opciones } = await cancelar(EstadoPedido.SOLICITADO);
    expect(opciones).toEqual({ bolsaEnManosDeBodega: true });
  });

  it('EN_REVISION con bodeguero: lo trae en las manos y lo regresa él', async () => {
    const { opciones } = await cancelar(EstadoPedido.EN_REVISION, { asignadoAId: 42 });
    expect(opciones).toEqual({ bolsaEnManosDeBodega: true });
  });

  it('EN_REVISION en la cola y nunca surtido: no hay bolsa en ningún lado', async () => {
    // Lo liberó otro bodeguero a medias, o apenas entró a la cola.
    const { opciones } = await cancelar(EstadoPedido.EN_REVISION, { cerroSurtidoAntes: false });
    expect(opciones).toEqual({ bolsaEnManosDeBodega: true });
  });

  it('EN_REVISION que VOLVIÓ del área de entrega: su bolsa sigue en la mesa, sí se lista', async () => {
    const { opciones } = await cancelar(EstadoPedido.EN_REVISION, { cerroSurtidoAntes: true });
    expect(opciones).toEqual({ bolsaEnManosDeBodega: false });
  });

  it.each([
    [EstadoPedido.REVISADO],
    [EstadoPedido.EN_ATENCION],
    [EstadoPedido.ESPERANDO_APROBACION],
    [EstadoPedido.EN_ASESORIA],
    [EstadoPedido.PENDIENTE_PAGO],
  ])('%s: la bolsa ya salió de bodega, sí se lista', async (estado) => {
    const { opciones, prisma } = await cancelar(estado);
    expect(opciones).toEqual({ bolsaEnManosDeBodega: false });
    // Y no hizo falta consultar el historial.
    expect(prisma.historialPedido.findFirst).not.toHaveBeenCalled();
  });
});

describe('oct 2026 — con una transferencia en curso el cliente no cancela solo', () => {
  it.each([
    ['EN_REVISION', /comprobante/i],
    ['VERIFICADO', /verificada/i],
  ])('transferencia %s: 409 y no toca el pedido', async (estadoPago, mensaje) => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO, {
      pagoEnCurso: { id: 3, estado: estadoPago },
    });
    await expect(svc.cancelarPedido(1, usuario.userId, usuario)).rejects.toThrow(mensaje);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('sin transferencia que lo impida, cancela como siempre', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO);
    await svc.cancelarPedido(1, usuario.userId, usuario);
    expect(cambiarEstado).toHaveBeenCalledTimes(1);
  });
});
