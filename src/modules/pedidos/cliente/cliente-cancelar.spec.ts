import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega, RolUsuario } from '@prisma/client';
import { ClienteService } from './cliente.service';

/**
 * El cliente cancela su propio pedido (F20, reescrito en oct 2026 sobre UNA decisión:
 * `core/cancelacion-cliente.util.ts`).
 *
 * Las 48 combinaciones estado × pago de la regla viven en `cancelacion-cliente.util.spec.ts`; el cruce con la BD
 * real (lista = detalle = cancelación) en `cliente-cancelar-postgres.spec.ts`. Aquí, la orquestación del servicio.
 *
 * Bugs de F20 que esto sigue fijando:
 *  1. NO validaba el estado: el cliente podía cancelar un pedido ya PAGADO (`TRANSICIONES[PAGADO]` incluye CANCELADO
 *     para Firebird/SWCANCEL, y NO se toca: la web se adecúa al ERP; el límite va en el camino del CLIENTE).
 *  2. NO creaba la lista de reposición: la mercancía apartada se quedaba sin quien la devolviera al anaquel.
 */

const DUENO = 100;
const usuario = { userId: DUENO, rol: RolUsuario.CLIENTE, tiendaId: 5, nombre: 'Cliente' };

function crearServicio(
  estado: EstadoPedido | null,
  opts: {
    /** El bodeguero que lo tiene asignado (solo importa en EN_REVISION). */
    asignadoAId?: number | null;
    /** Si el historial muestra que alguna vez se cerró un surtido. */
    cerroSurtidoAntes?: boolean;
    modoEntrega?: ModoEntrega;
    /** El pago que ve la decisión al leer el pedido (antes de cancelar). */
    pago?: EstadoPagoTransferencia | null;
    /** Un comprobante que llega ENTRE la lectura y la escritura (lo ve la guarda de dentro de la transacción). */
    pagoLlegaDespues?: EstadoPagoTransferencia | null;
    propuestaPendiente?: { id: number } | null;
  } = {},
) {
  const crearDesdePedido = jest.fn().mockResolvedValue(undefined);
  const emitToPedido = jest.fn();
  const emitToTienda = jest.fn();
  /** Cuántos avisos se habían emitido cuando la «transacción» aún no confirmaba (debe ser 0). */
  const emitidosAntesDelCommit: number[] = [];

  const prisma = {
    pedido: {
      // Respeta el dueño: un cliente ajeno no encuentra el pedido.
      findFirst: jest.fn().mockImplementation(async ({ where }) =>
        estado === null || where.usuarioId !== DUENO
          ? null
          : {
              id: where.id,
              estado,
              asignadoAId: opts.asignadoAId ?? null,
              modoEntrega: opts.modoEntrega ?? ModoEntrega.RECOGER_TIENDA,
              tiendaId: 5,
            },
      ),
    },
    historialPedido: {
      findFirst: jest.fn().mockResolvedValue(opts.cerroSurtidoAntes ? { id: 9 } : null),
    },
    pedidoPagoTransferencia: {
      findMany: jest.fn().mockResolvedValue(opts.pago ? [{ pedidoId: 1, estado: opts.pago }] : []),
    },
  };

  // La transacción que la máquina de estados le da a los `efectos`.
  const tx = {
    pedidoPagoTransferencia: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.pagoLlegaDespues ? { estado: opts.pagoLlegaDespues } : null),
    },
    pedidoPropuesta: {
      findFirst: jest.fn().mockResolvedValue(opts.propuestaPendiente ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pedidoCancelacionCliente: { create: jest.fn().mockResolvedValue({}) },
  };

  // Como la máquina de estados real: los `efectos` corren DENTRO de la transacción, antes de que confirme.
  const cambiarEstado = jest.fn().mockImplementation(async (_id, _dto, _usuario, o) => {
    await o?.efectos?.(tx as never);
    emitidosAntesDelCommit.push(emitToPedido.mock.calls.length + emitToTienda.mock.calls.length);
    return { id: 1, estado: EstadoPedido.CANCELADO };
  });

  const svc = new ClienteService(
    prisma as never,
    {} as never, // notifications
    { emitToPedido, emitToTienda } as never, // realtime
    { cambiarEstado } as never, // state
    {} as never, // storage
    {} as never, // kioskoService
    {} as never, // kioskoLlegada
    {} as never, // precios
    { crearDesdePedido } as never, // reposicion
    {} as never, // presencia (F22)
    {} as never, // sinRecoger (F22)
  );

  return {
    svc,
    cambiarEstado,
    crearDesdePedido,
    prisma,
    tx,
    emitToPedido,
    emitToTienda,
    emitidosAntesDelCommit,
  };
}

describe('F20 — el cliente NO puede cancelar un pedido ya pagado', () => {
  it.each([[EstadoPedido.PAGADO], [EstadoPedido.ENVIADO], [EstadoPedido.ENTREGADO]])(
    'rechaza cancelar desde %s (409)',
    async (estado) => {
      const { svc, cambiarEstado, crearDesdePedido } = crearServicio(estado);

      await expect(svc.cancelarPedido(1, DUENO, usuario)).rejects.toThrow(ConflictException);

      // Y no se movió nada: ni la transición ni la reposición.
      expect(cambiarEstado).not.toHaveBeenCalled();
      expect(crearDesdePedido).not.toHaveBeenCalled();
    },
  );

  it('el mensaje explica por qué y manda a mostrador', async () => {
    const { svc } = crearServicio(EstadoPedido.PAGADO);
    await expect(svc.cancelarPedido(1, DUENO, usuario)).rejects.toThrow(/ya fue pagado/i);
    await expect(svc.cancelarPedido(1, DUENO, usuario)).rejects.toThrow(/mostrador/i);
  });
});

describe('oct 2026 — «En atención» se cierra para el cliente', () => {
  it('409 con un motivo claro y un código estable, sin tocar nada', async () => {
    const { svc, cambiarEstado, crearDesdePedido } = crearServicio(EstadoPedido.EN_ATENCION);

    const err = await svc.cancelarPedido(1, DUENO, usuario).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      codigo: 'EN_ATENCION',
      message: expect.stringMatching(/díselo a la persona que te atiende/i),
    });
    expect(cambiarEstado).not.toHaveBeenCalled();
    expect(crearDesdePedido).not.toHaveBeenCalled();
  });

  it('EN_DTF se explica distinto: se cancela desde la tarjeta de cada diseño', async () => {
    const { svc } = crearServicio(EstadoPedido.EN_DTF);
    await expect(svc.cancelarPedido(1, DUENO, usuario)).rejects.toThrow(
      /cada diseño desde su tarjeta/i,
    );
  });
});

describe('F20 — el cliente SÍ puede cancelar antes del cobro', () => {
  it.each([
    [EstadoPedido.SOLICITADO],
    [EstadoPedido.EN_REVISION],
    [EstadoPedido.REVISADO],
    [EstadoPedido.ESPERANDO_APROBACION],
    [EstadoPedido.EN_ASESORIA],
    [EstadoPedido.PENDIENTE_PAGO],
  ])('permite cancelar desde %s', async (estado) => {
    const { svc, cambiarEstado } = crearServicio(estado);

    await svc.cancelarPedido(1, DUENO, usuario);

    expect(cambiarEstado).toHaveBeenCalledTimes(1);
    const [, dto] = cambiarEstado.mock.calls[0];
    expect(dto.nuevoEstado).toBe(EstadoPedido.CANCELADO);
  });

  it('exige que el pedido SIGA en el estado que se leyó (si lo llamaron a mostrador entre tanto, 409)', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario);
    const [, , , opts] = cambiarEstado.mock.calls[0];
    expect(opts.desdeEstados).toEqual([EstadoPedido.REVISADO]);
  });
});

describe('oct 2026 — el pedido es del cliente que lo cancela', () => {
  it('el pedido de OTRO es un 404 y no se entera de en qué estado está', async () => {
    // Antes se leía el pedido a secas: un cliente recibía «ya fue pagado» (409) sobre el pedido de otro.
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PAGADO);
    await expect(
      svc.cancelarPedido(1, DUENO + 1, { ...usuario, userId: DUENO + 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('un pedido inexistente es un 404', async () => {
    const { svc } = crearServicio(null);
    await expect(svc.cancelarPedido(999, DUENO, usuario)).rejects.toThrow(NotFoundException);
  });
});

describe('F20 — la cancelación del cliente crea la lista de reposición', () => {
  it('llama a crearDesdePedido con el motivo FIJO (el del cliente no va ahí: sale en el correo)', async () => {
    const { svc, crearDesdePedido } = crearServicio(EstadoPedido.REVISADO);

    await svc.cancelarPedido(1, DUENO, usuario, { motivo: 'OTRO', detalle: 'algo muy personal' });

    expect(crearDesdePedido).toHaveBeenCalledTimes(1);
    const [, pedidoId, motivo] = crearDesdePedido.mock.calls[0];
    expect(pedidoId).toBe(1);
    expect(motivo).toBe('Cancelado por el cliente');
  });

  it('la reposición corre DENTRO de los efectos de la transición', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario);
    const [, , , opts] = cambiarEstado.mock.calls[0];
    expect(typeof opts.efectos).toBe('function');
  });

  it('el pedido se libera y el reloj se detiene', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario);
    const [, , , opts] = cambiarEstado.mock.calls[0];
    expect(opts.asignacion).toBe('limpiar');
    expect(opts.reloj).toBe('detener');
  });

  it('el historial dice siempre lo mismo, sin el motivo del cliente', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario, { motivo: 'OTRO', detalle: 'mi secreto' });
    const [, dto] = cambiarEstado.mock.calls[0];
    expect(dto.observacion).toBe('Cancelado por el cliente');
  });
});

describe('oct 2026 — la cancelación solo genera lista si la bolsa salió de las manos de bodega', () => {
  /** Corre los `efectos` de la transición y devuelve las opciones que recibió la reposición. */
  async function cancelar(
    estado: EstadoPedido,
    opts: { asignadoAId?: number | null; cerroSurtidoAntes?: boolean } = {},
  ) {
    const { svc, crearDesdePedido, prisma } = crearServicio(estado, opts);
    await svc.cancelarPedido(1, DUENO, usuario);
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
    const { opciones } = await cancelar(EstadoPedido.EN_REVISION, { cerroSurtidoAntes: false });
    expect(opciones).toEqual({ bolsaEnManosDeBodega: true });
  });

  it('EN_REVISION que VOLVIÓ del área de entrega: su bolsa sigue en la mesa, sí se lista', async () => {
    const { opciones } = await cancelar(EstadoPedido.EN_REVISION, { cerroSurtidoAntes: true });
    expect(opciones).toEqual({ bolsaEnManosDeBodega: false });
  });

  it.each([
    [EstadoPedido.REVISADO],
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
    [EstadoPagoTransferencia.EN_REVISION, /comprobante/i, 'PAGO_EN_REVISION'],
    [EstadoPagoTransferencia.VERIFICADO, /verificada/i, 'PAGO_VERIFICADO'],
  ])('transferencia %s: 409 y no toca el pedido', async (pago, mensaje, codigo) => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO, { pago });
    const err = await svc.cancelarPedido(1, DUENO, usuario).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({ codigo, message: expect.stringMatching(mensaje) });
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('sin transferencia que lo impida, cancela como siempre', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO);
    await svc.cancelarPedido(1, DUENO, usuario);
    expect(cambiarEstado).toHaveBeenCalledTimes(1);
  });

  it('un comprobante que llega ENTRE la lectura y la escritura revienta la transacción (nada queda a medias)', async () => {
    const { svc, crearDesdePedido, tx } = crearServicio(EstadoPedido.PENDIENTE_PAGO, {
      pagoLlegaDespues: EstadoPagoTransferencia.EN_REVISION,
    });

    const err = await svc
      .cancelarPedido(1, DUENO, usuario, { motivo: 'TARDO_MUCHO' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().codigo).toBe('PAGO_EN_REVISION');
    // Como la transacción se revierte entera, no se alcanzó a crear lista, cerrar propuesta ni guardar motivo.
    expect(crearDesdePedido).not.toHaveBeenCalled();
    expect(tx.pedidoCancelacionCliente.create).not.toHaveBeenCalled();
  });
});

describe('oct 2026 — transferencia PENDIENTE: «¿ya transferiste?»', () => {
  it('sin la confirmación, 409 CONFIRMAR_TRANSFERENCIA y no se cancela', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO, {
      pago: EstadoPagoTransferencia.PENDIENTE,
    });
    const err = await svc.cancelarPedido(1, DUENO, usuario).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().codigo).toBe('CONFIRMAR_TRANSFERENCIA');
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('un «false» tampoco cuenta como confirmación', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO, {
      pago: EstadoPagoTransferencia.PENDIENTE,
    });
    await expect(svc.cancelarPedido(1, DUENO, usuario, { noHeTransferido: false })).rejects.toThrow(
      ConflictException,
    );
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('con la confirmación, cancela', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO, {
      pago: EstadoPagoTransferencia.PENDIENTE,
    });
    await svc.cancelarPedido(1, DUENO, usuario, { noHeTransferido: true });
    expect(cambiarEstado).toHaveBeenCalledTimes(1);
  });

  it('sin transferencia pendiente no se pide ninguna confirmación', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.PENDIENTE_PAGO);
    await svc.cancelarPedido(1, DUENO, usuario);
    expect(cambiarEstado).toHaveBeenCalledTimes(1);
  });
});

describe('oct 2026 — el motivo (opcional) solo se guarda si el cliente lo dio', () => {
  it('sin motivo NO se guarda nada', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario);
    expect(tx.pedidoCancelacionCliente.create).not.toHaveBeenCalled();
  });

  it('un cuerpo con puros espacios en el texto tampoco guarda nada', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario, { detalle: '   ' });
    expect(tx.pedidoCancelacionCliente.create).not.toHaveBeenCalled();
  });

  it('con motivo se guarda en la MISMA transacción, con el estado en que cancelaba', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario, { motivo: 'TARDO_MUCHO' });
    expect(tx.pedidoCancelacionCliente.create).toHaveBeenCalledWith({
      data: {
        pedidoId: 1,
        tiendaId: 5,
        usuarioId: DUENO,
        motivo: 'TARDO_MUCHO',
        detalle: null,
        estadoAlCancelar: EstadoPedido.REVISADO,
      },
    });
  });

  it('«Otro» guarda su texto', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.SOLICITADO);
    await svc.cancelarPedido(1, DUENO, usuario, { motivo: 'OTRO', detalle: 'Me voy de viaje' });
    expect(tx.pedidoCancelacionCliente.create.mock.calls[0][0].data).toMatchObject({
      motivo: 'OTRO',
      detalle: 'Me voy de viaje',
    });
  });

  it('un texto con un motivo que no es «Otro» se rechaza ANTES de cancelar', async () => {
    const { svc, cambiarEstado } = crearServicio(EstadoPedido.REVISADO);
    await expect(
      svc.cancelarPedido(1, DUENO, usuario, { motivo: 'TARDO_MUCHO', detalle: 'hola' }),
    ).rejects.toThrow(BadRequestException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('el motivo NO se escribe en la propuesta ni en el aviso a la tienda', async () => {
    const { svc, tx } = crearServicio(EstadoPedido.ESPERANDO_APROBACION, {
      propuestaPendiente: { id: 7 },
    });
    await svc.cancelarPedido(1, DUENO, usuario, { motivo: 'OTRO', detalle: 'privado' });
    const data = tx.pedidoPropuesta.updateMany.mock.calls[0][0].data;
    expect(JSON.stringify(data)).not.toMatch(/privado/);
    expect(data).not.toHaveProperty('notaCliente');
  });
});

describe('oct 2026 — cancelar cierra la propuesta que esperaba la decisión del cliente', () => {
  it('la deja RECHAZADA en la misma transacción y avisa DESPUÉS del commit', async () => {
    const { svc, tx, emitToPedido, emitToTienda, emitidosAntesDelCommit } = crearServicio(
      EstadoPedido.ESPERANDO_APROBACION,
      { propuestaPendiente: { id: 7 } },
    );

    await svc.cancelarPedido(1, DUENO, usuario);

    // Mientras la transacción no confirmaba, nadie recibió el aviso (emitir antes del commit deja un aviso falso si hay rollback).
    expect(emitidosAntesDelCommit).toEqual([0]);

    expect(tx.pedidoPropuesta.updateMany).toHaveBeenCalledWith({
      where: { id: 7, estado: 'PENDIENTE' },
      data: { estado: 'RECHAZADA', respondidaAt: expect.any(Date) },
    });
    expect(emitToPedido).toHaveBeenCalledWith(
      1,
      'propuesta.respondida',
      expect.objectContaining({ propuestaId: 7, estado: 'RECHAZADA', decision: 'CANCELAR_PEDIDO' }),
    );
    expect(emitToTienda).toHaveBeenCalledWith(5, 'propuesta.respondida', expect.anything());
  });

  it('sin propuesta pendiente no toca ninguna ni emite nada', async () => {
    const { svc, tx, emitToPedido } = crearServicio(EstadoPedido.REVISADO);
    await svc.cancelarPedido(1, DUENO, usuario);
    expect(tx.pedidoPropuesta.updateMany).not.toHaveBeenCalled();
    expect(emitToPedido).not.toHaveBeenCalled();
  });
});
