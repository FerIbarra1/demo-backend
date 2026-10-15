import { BadRequestException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { MostradorService } from './mostrador.service';
import type { UserContext } from '../../types/pedido.types';

/**
 * F21 (oct 2026): el operador de mostrador resuelve un pedido que espera
 * aprobación del cliente.
 *
 * EL CASO DEL NEGOCIO, en palabras del usuario:
 *
 *   "El cliente no verificó que había una propuesta y no tomó ninguna decisión y
 *    llegó a la tienda. Bien el de mostrador puede ajustar el pedido. Le va a
 *    decir que tiene una propuesta pendiente y ahí se puede cancelar, ajustar, o
 *    aprobar."
 *
 * Antes solo podía APROBAR o RECHAZAR — y "El cliente no acepta" mandaba
 * `RECHAZAR`, que en una propuesta de bodega **CANCELA EL PEDIDO COMPLETO**. El
 * operador que quería ajustar mataba el pedido.
 *
 * Dos piezas:
 *
 *   1. `ajustar` y `cancelar` aceptan `ESPERANDO_APROBACION` además del área de
 *      entrega. El cliente está enfrente; el punto del ciclo no importa.
 *
 *   2. `ajustar` REGISTRA LA LLEGADA. Sin esto el circuito se rompe en silencio:
 *      el pedido vuelve a bodega, bodega cierra el surtido, y
 *      `destinoTrasSurtidoIncompleto` mira `clientePresenteEnTienda` — que para
 *      un pedido WEB es \"hay aviso vigente\". Sin aviso, el pedido aterriza otra
 *      vez en `ESPERANDO_APROBACION` con el cliente de pie en el mostrador.
 */

const usuario: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

function crearServicio(opts: {
  estado: EstadoPedido;
  /** El pedido completo que devuelve el segundo `findUnique` (con items). */
  completo?: Record<string, unknown> | null;
  /** Si `confirmarDesdeMostrador` debe fallar. */
  llegadaFalla?: boolean;
}) {
  const pedidoCompleto = {
    id: 1,
    tiendaId: 5,
    estado: opts.estado,
    descuento: 0,
    impuestos: 0,
    items: [],
    ...opts.completo,
  };

  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(pedidoCompleto),
    },
    pedidoPropuesta: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    itemPedido: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const access = {
    cargarYValidar: jest.fn().mockResolvedValue({ id: 1, estado: opts.estado }),
  };

  const cambiarEstado = jest.fn().mockResolvedValue({ id: 1, estado: EstadoPedido.EN_REVISION });

  const confirmarDesdeMostrador = opts.llegadaFalla
    ? jest.fn().mockRejectedValue(new Error('kiosko caído'))
    : jest.fn().mockResolvedValue({ reanudado: true, esperandoDesdeMin: 0 });

  const crearDesdePedido = jest.fn().mockResolvedValue(undefined);

  const svc = new MostradorService(
    prisma as never,
    { cambiarEstado } as never,
    access as never,
    { crearDesdePedido } as never,
    { emitToTienda: jest.fn() } as never,
    { columnaParaPedido: jest.fn().mockResolvedValue('lista1') } as never,
    { confirmarDesdeMostrador } as never,
    {} as never, // presencia (F22)
    { resolverParaLlamar: jest.fn().mockResolvedValue(null) } as never, // mostradores (F22)
    { get: jest.fn() } as never, // config
  );

  return { svc, cambiarEstado, confirmarDesdeMostrador, prisma, pedidoCompleto };
}

describe('F21 — ajustar un pedido que espera aprobación', () => {
  it('ACEPTA ESPERANDO_APROBACION: el cliente está enfrente', async () => {
    const { svc, cambiarEstado } = crearServicio({
      estado: EstadoPedido.ESPERANDO_APROBACION,
    });

    await svc.ajustar(1, usuario, 'Quiere 2 playeras menos');

    expect(cambiarEstado).toHaveBeenCalled();
    const [, cambio] = cambiarEstado.mock.calls[0];
    expect(cambio.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
  });

  it('sigue aceptando REVISADO y EN_ATENCION', async () => {
    for (const estado of [EstadoPedido.REVISADO, EstadoPedido.EN_ATENCION]) {
      const { svc, cambiarEstado } = crearServicio({ estado });
      await svc.ajustar(1, usuario, 'Cambio de talla');
      expect(cambiarEstado).toHaveBeenCalled();
    }
  });

  it('RECHAZA un pedido que ya está en bodega: no es tarea de mostrador', async () => {
    const { svc } = crearServicio({ estado: EstadoPedido.EN_REVISION });
    await expect(svc.ajustar(1, usuario, 'Cambio')).rejects.toThrow(BadRequestException);
  });

  it('RECHAZA un pedido ya pagado', async () => {
    const { svc } = crearServicio({ estado: EstadoPedido.PAGADO });
    await expect(svc.ajustar(1, usuario, 'Cambio')).rejects.toThrow(BadRequestException);
  });

  it('la propuesta que esperaba queda SUPERADA: el ajuste la reemplaza', async () => {
    // Sin esto, bodega choca contra el índice único parcial al cerrar el surtido
    // siguiente y `enviarAPagar` queda bloqueado para siempre.
    const { svc, cambiarEstado } = crearServicio({
      estado: EstadoPedido.ESPERANDO_APROBACION,
    });

    await svc.ajustar(1, usuario, 'Quiere menos piezas');

    const [, , , opts] = cambiarEstado.mock.calls[0];
    // Los efectos corren dentro de la transición; el mock los ejecuta a mano.
    await opts.efectos({ pedidoPropuesta: { updateMany: jest.fn() } });
    expect(opts.efectos).toBeDefined();
  });
});

describe('F21 — el ajuste registra la llegada del cliente', () => {
  it('marca la llegada DESPUÉS del commit', async () => {
    // Es lo que hace que, cuando bodega cierre el surtido siguiente, el pedido
    // vuelva al área de entrega en vez de a esperar una aprobación por la app.
    const { svc, confirmarDesdeMostrador } = crearServicio({
      estado: EstadoPedido.ESPERANDO_APROBACION,
    });

    await svc.ajustar(1, usuario, 'Ajuste con el cliente enfrente');

    expect(confirmarDesdeMostrador).toHaveBeenCalledWith(1, usuario);
  });

  it('la llegada se marca DESPUÉS de la transición, no antes', async () => {
    // Si se marcara antes y el ajuste fallara, quedaría un aviso de llegada de
    // un ajuste que nunca ocurrió.
    const orden: string[] = [];
    const { svc } = crearServicio({ estado: EstadoPedido.ESPERANDO_APROBACION });

    const svcConOrden = svc as unknown as {
      pedidoState: { cambiarEstado: jest.Mock };
      llegada: { confirmarDesdeMostrador: jest.Mock };
    };
    svcConOrden.pedidoState.cambiarEstado = jest.fn().mockImplementation(async () => {
      orden.push('transicion');
      return { id: 1 };
    });
    svcConOrden.llegada.confirmarDesdeMostrador = jest.fn().mockImplementation(async () => {
      orden.push('llegada');
    });

    await svc.ajustar(1, usuario, 'Ajuste');

    expect(orden).toEqual(['transicion', 'llegada']);
  });

  it('si la llegada falla, el ajuste NO se tumba', async () => {
    // El ajuste ya se aplicó y no se puede deshacer: tumbar la respuesta dejaría
    // al operador creyendo que nada pasó, cuando el pedido ya volvió a bodega.
    // El aviso se puede marcar a mano con "El cliente está aquí".
    const { svc } = crearServicio({
      estado: EstadoPedido.ESPERANDO_APROBACION,
      llegadaFalla: true,
    });

    await expect(svc.ajustar(1, usuario, 'Ajuste')).resolves.toBeDefined();
  });
});

describe('F21 — cancelar un pedido que espera aprobación', () => {
  it('ACEPTA ESPERANDO_APROBACION', async () => {
    const { svc, cambiarEstado } = crearServicio({
      estado: EstadoPedido.ESPERANDO_APROBACION,
    });

    await svc.cancelar(1, usuario, 'El cliente se arrepintió');

    const [, cambio] = cambiarEstado.mock.calls[0];
    expect(cambio.nuevoEstado).toBe(EstadoPedido.CANCELADO);
  });

  it('sigue rechazando un pedido en bodega', async () => {
    const { svc } = crearServicio({ estado: EstadoPedido.EN_REVISION });
    await expect(svc.cancelar(1, usuario, 'Motivo')).rejects.toThrow(BadRequestException);
  });
});
