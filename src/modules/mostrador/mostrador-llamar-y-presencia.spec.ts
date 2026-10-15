import { BadRequestException } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { MostradorService } from './mostrador.service';

/**
 * F22 (oct 2026): llamar con mostrador, cola justa y cancelar vencidos.
 *
 * Qué previenen estos tests:
 *
 *  - `llamar` a un cliente que NO está en la tienda lo movía a `EN_ATENCION`, donde
 *    la consola y la TV (que exigen cliente presente) ya no lo mostraban: la TV
 *    anunciaba un folio de alguien ausente y el pedido quedaba huérfano.
 *  - Con dos operadores, "Pasa a mostrador" a secas deja al cliente sin saber a
 *    quién acercarse.
 *  - `traerAEntrega` no registraba la llegada (`ajustar` sí): un pedido web traído
 *    desde asesoría quedaba oculto con el cliente de pie enfrente.
 *  - Cancelar vencidos tiene que revalidar CADA pedido: la lista que vio el operador
 *    pudo envejecer y el cliente pudo llegar entre tanto.
 */

const operador = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

const presente = {
  numeroPedido: 'PD-2026-000123',
  clienteNombre: 'Juan',
  tiendaId: 5,
  canalOrigen: 'WEB',
  llegadaAnunciadaAt: new Date(Date.now() - 300_000),
  llegadaDescartadaAt: null,
};

function crearServicio(
  opts: {
    estado?: EstadoPedido;
    completo?: Record<string, unknown>;
    mostrador?: { id: number; numero: number } | null;
    mostradorError?: Error;
    siguiente?: { id: number } | null;
    vigentes?: Array<{ id: number }>;
    config?: Record<string, unknown>;
  } = {},
) {
  const txUpdate = jest.fn().mockResolvedValue({});
  const findFirst = jest
    .fn()
    .mockResolvedValue(opts.siguiente === undefined ? { id: 1 } : opts.siguiente);
  const findMany = jest.fn().mockResolvedValue(opts.vigentes ?? []);
  const prisma = {
    pedido: {
      findUnique: jest.fn().mockResolvedValue(opts.completo ?? presente),
      findFirst,
      findMany,
    },
    pedidoPropuesta: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, o: any) => {
    if (o?.efectos) await o.efectos({ pedido: { update: txUpdate } });
    return {};
  });
  const access = {
    cargarYValidar: jest
      .fn()
      .mockResolvedValue({ id: 1, estado: opts.estado ?? EstadoPedido.REVISADO }),
  };
  const emitToTienda = jest.fn();
  const confirmarDesdeMostrador = jest.fn().mockResolvedValue({ reanudado: true });
  const presencia = {
    descartar: jest.fn().mockResolvedValue({ ok: true, pedidoId: 1 }),
    noSePresento: jest.fn().mockResolvedValue({ ok: true, pedidoId: 1, descartado: false }),
  };
  const mostradores = {
    resolverParaLlamar: opts.mostradorError
      ? jest.fn().mockRejectedValue(opts.mostradorError)
      : jest.fn().mockResolvedValue(opts.mostrador === undefined ? null : opts.mostrador),
  };
  const config = { get: jest.fn().mockReturnValue(opts.config) };

  const svc = new MostradorService(
    prisma as never,
    { cambiarEstado } as never,
    access as never,
    {} as never, // reposicion
    { emitToTienda } as never,
    {} as never, // precios
    { confirmarDesdeMostrador } as never,
    presencia as never,
    mostradores as never,
    config as never,
  );
  return {
    svc,
    prisma,
    txUpdate,
    cambiarEstado,
    emitToTienda,
    confirmarDesdeMostrador,
    presencia,
    mostradores,
    findFirst,
    findMany,
  };
}

describe('MostradorService.llamar — desde qué mostrador', () => {
  it('escribe llamadoAt, quién llamó y el mostrador DENTRO de la transición', async () => {
    const { svc, txUpdate, cambiarEstado } = crearServicio({ mostrador: { id: 8, numero: 2 } });

    await svc.llamar(1, operador);

    expect(cambiarEstado).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ nuevoEstado: EstadoPedido.EN_ATENCION }),
      operador,
      expect.objectContaining({ invalidarMonitor: true }),
    );
    // Antes `llamadoAt` era un `update` aparte tras el commit: si fallaba, el pedido
    // quedaba EN_ATENCION sin fecha de llamada.
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { llamadoAt: expect.any(Date), llamadoPorId: 3, llamadoMostradorId: 8 },
    });
  });

  it('la TV recibe el número de mostrador en la alerta', async () => {
    const { svc, emitToTienda } = crearServicio({ mostrador: { id: 8, numero: 2 } });

    const r = await svc.llamar(1, operador);

    expect(emitToTienda).toHaveBeenCalledWith(
      5,
      'pedido.llamado-mostrador',
      expect.objectContaining({
        numeroPedido: 'PD-2026-000123',
        operadorNombre: 'Ana Mostrador',
        mostradorId: 8,
        mostradorNumero: 2,
      }),
    );
    expect(r).toMatchObject({ mostradorNumero: 2, mostradorId: 8 });
  });

  it('el historial dice a qué mostrador se llamó', async () => {
    const { svc, cambiarEstado } = crearServicio({ mostrador: { id: 8, numero: 2 } });
    await svc.llamar(1, operador);
    expect(cambiarEstado.mock.calls[0][1].observacion).toMatch(/mostrador 2/i);
  });

  it('sin mostradores configurados llama igual, sin número (tienda de una sola mesa)', async () => {
    const { svc, txUpdate, emitToTienda } = crearServicio({ mostrador: null });

    const r = await svc.llamar(1, operador);

    expect(r.mostradorNumero).toBeNull();
    expect(txUpdate.mock.calls[0][0].data.llamadoMostradorId).toBeNull();
    expect(emitToTienda.mock.calls[0][2]).toEqual(
      expect.objectContaining({ mostradorId: null, mostradorNumero: null }),
    );
  });

  it('con mostradores configurados y sin elegir, NO llama (400) ni mueve el pedido', async () => {
    const { svc, cambiarEstado, emitToTienda } = crearServicio({
      mostradorError: new BadRequestException('Elige tu mostrador antes de llamar'),
    });

    await expect(svc.llamar(1, operador)).rejects.toThrow(/elige tu mostrador/i);
    expect(cambiarEstado).not.toHaveBeenCalled();
    expect(emitToTienda).not.toHaveBeenCalled();
  });

  it('el mostrador se resuelve con la TIENDA DEL PEDIDO, no con la del header', async () => {
    const { svc, mostradores } = crearServicio({ mostrador: null });
    await svc.llamar(1, operador);
    expect(mostradores.resolverParaLlamar).toHaveBeenCalledWith(3, 5);
  });
});

describe('MostradorService.llamar — solo se llama a quien está en la tienda', () => {
  it('rechaza un pedido web que nunca avisó llegada', async () => {
    // Llamarlo lo movía a EN_ATENCION, donde la consola y la TV ya no lo mostraban
    // (exigen cliente presente): la TV anunciaba un folio ausente y el pedido
    // quedaba huérfano.
    const { svc, cambiarEstado, emitToTienda } = crearServicio({
      completo: { ...presente, llegadaAnunciadaAt: null },
    });

    await expect(svc.llamar(1, operador)).rejects.toThrow(/no ha avisado/i);
    expect(cambiarEstado).not.toHaveBeenCalled();
    expect(emitToTienda).not.toHaveBeenCalled();
  });

  it('rechaza un pedido cuyo aviso fue descartado', async () => {
    const { svc, cambiarEstado } = crearServicio({
      completo: { ...presente, llegadaDescartadaAt: new Date() },
    });
    await expect(svc.llamar(1, operador)).rejects.toThrow(BadRequestException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('rechaza un kiosko descartado (el cliente se fue)', async () => {
    const { svc } = crearServicio({
      completo: {
        ...presente,
        canalOrigen: 'KIOSKO',
        llegadaAnunciadaAt: null,
        llegadaDescartadaAt: new Date(),
      },
    });
    await expect(svc.llamar(1, operador)).rejects.toThrow(/no ha avisado/i);
  });

  it('un pedido de KIOSKO presente se llama sin necesidad de aviso', async () => {
    const { svc, cambiarEstado } = crearServicio({
      completo: { ...presente, canalOrigen: 'KIOSKO', llegadaAnunciadaAt: null },
    });
    await svc.llamar(1, operador);
    expect(cambiarEstado).toHaveBeenCalled();
  });

  it('solo desde REVISADO: a un ya llamado no se le vuelve a sonar la alerta', async () => {
    const { svc, cambiarEstado } = crearServicio({ estado: EstadoPedido.EN_ATENCION });
    await expect(svc.llamar(1, operador)).rejects.toThrow(BadRequestException);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('el mensaje explica la salida: marcar la llegada o enviar a pagar', async () => {
    const { svc } = crearServicio({ completo: { ...presente, llegadaAnunciadaAt: null } });
    await expect(svc.llamar(1, operador)).rejects.toThrow(/El cliente está aquí/);
  });
});

describe('MostradorService.llamarSiguiente — primero llegado, primero atendido', () => {
  it('usa el MISMO gate y el MISMO orden que la cola', async () => {
    const { svc, findFirst } = crearServicio();

    await svc.llamarSiguiente(operador);

    const args = findFirst.mock.calls[0][0];
    expect(args.where.tiendaId).toBe(5);
    expect(args.where.estado).toBe(EstadoPedido.REVISADO);
    // Presencia: sin descarte Y (kiosko O web con aviso).
    expect(args.where.llegadaDescartadaAt).toBeNull();
    expect(args.where.OR).toBeDefined();
    // Orden: presenteDesdeAt (hora del pedido en kiosko, del aviso en web). El viejo
    // era `llegadaAnunciadaAt nulls last`: todo web con aviso pasaba delante de
    // cualquier kiosko aunque este llevara media hora esperando.
    expect(args.orderBy[0]).toEqual({ presenteDesdeAt: { sort: 'asc', nulls: 'last' } });
  });

  it('sin nadie en la cola, 404 con un mensaje claro', async () => {
    const { svc } = crearServicio({ siguiente: null });
    await expect(svc.llamarSiguiente(operador)).rejects.toThrow(/no hay pedidos/i);
  });

  it('llama al primero a través de `llamar` (mismos efectos y mismo mostrador)', async () => {
    const { svc, mostradores } = crearServicio({
      siguiente: { id: 1 },
      mostrador: { id: 8, numero: 2 },
    });
    const r = await svc.llamarSiguiente(operador);
    expect(r.mostradorNumero).toBe(2);
    expect(mostradores.resolverParaLlamar).toHaveBeenCalled();
  });
});

describe('MostradorService.traerAEntrega — el cliente está enfrente', () => {
  it('registra la llegada: sin eso el pedido web queda oculto en "Sin aviso"', async () => {
    // `ajustar` ya lo hacía; esta acción no. Un pedido web traído desde asesoría,
    // sin aviso, no cumple el gate de presencia y NO aparece en la cola ni en la TV,
    // aunque el operador lo trajo justo porque el cliente está de pie enfrente.
    const { svc, confirmarDesdeMostrador } = crearServicio({ estado: EstadoPedido.EN_ASESORIA });

    await svc.traerAEntrega(1, operador);

    expect(confirmarDesdeMostrador).toHaveBeenCalledWith(1, operador);
  });

  it('no manda el correo "listo en tienda" a quien está de pie en el mostrador', async () => {
    const { svc, cambiarEstado } = crearServicio({ estado: EstadoPedido.EN_ASESORIA });

    await svc.traerAEntrega(1, operador);

    expect(cambiarEstado.mock.calls[0][3]).toEqual(expect.objectContaining({ sinNotificar: true }));
  });

  it('si registrar la llegada falla, la transición YA se aplicó y no se tumba', async () => {
    const { svc, confirmarDesdeMostrador } = crearServicio({ estado: EstadoPedido.EN_ASESORIA });
    confirmarDesdeMostrador.mockRejectedValue(new Error('kiosko caído'));

    await expect(svc.traerAEntrega(1, operador)).resolves.toMatchObject({
      estado: EstadoPedido.REVISADO,
    });
  });

  it('solo desde EN_ASESORIA', async () => {
    const { svc, confirmarDesdeMostrador } = crearServicio({ estado: EstadoPedido.REVISADO });
    await expect(svc.traerAEntrega(1, operador)).rejects.toThrow(BadRequestException);
    expect(confirmarDesdeMostrador).not.toHaveBeenCalled();
  });
});

describe('MostradorService — descartar y "no se presentó" delegan en PresenciaService', () => {
  it('descartarLlegada', async () => {
    const { svc, presencia } = crearServicio();
    await svc.descartarLlegada(1, operador);
    expect(presencia.descartar).toHaveBeenCalledWith(1, operador);
  });

  it('noSePresento', async () => {
    const { svc, presencia } = crearServicio();
    await svc.noSePresento(1, operador);
    expect(presencia.noSePresento).toHaveBeenCalledWith(1, operador);
  });
});

describe('MostradorService.cancelarVencidos', () => {
  const config = { recordatorioHoras: 24, vencidoHoras: 72, presenciaCaducaHoras: 8 };

  it('cancela solo los que el servidor revalida como vencidos y sin cliente', async () => {
    const { svc, findMany } = crearServicio({ vigentes: [{ id: 10 }], config });
    const cancelar = jest.spyOn(svc, 'cancelar').mockResolvedValue({} as never);

    const r = await svc.cancelarVencidos(operador, [10, 11]);

    // Se revalida CADA pedido: la lista que vio el operador pudo envejecer, y entre
    // tanto el cliente pudo haber llegado.
    const where = findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: [10, 11] });
    expect(where.estado).toEqual({
      in: [EstadoPedido.REVISADO, EstadoPedido.ESPERANDO_APROBACION],
    });
    expect(where.OR).toBeDefined();
    const limite = (where.esperaClienteDesdeAt.lt as Date).getTime();
    expect(Math.abs(Date.now() - 72 * 3_600_000 - limite)).toBeLessThan(5_000);

    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(cancelar).toHaveBeenCalledWith(10, operador, expect.any(String));
    expect(r.canceladas).toEqual([10]);
    // El que ya no aplica se reporta con la razón, no falla el lote entero.
    expect(r.omitidas).toEqual([{ id: 11, razon: expect.stringMatching(/ya no está vencido/i) }]);
  });

  it('la tienda sale del JWT: un operador no cancela pedidos de otra tienda', async () => {
    const { svc, findMany } = crearServicio({ vigentes: [], config });
    await svc.cancelarVencidos(operador, [10]);
    expect(findMany.mock.calls[0][0].where.tiendaId).toBe(5);
  });

  it('ADMIN no queda acotado a una tienda', async () => {
    const { svc, findMany } = crearServicio({ vigentes: [], config });
    await svc.cancelarVencidos({ userId: 1, nombre: 'Admin', rol: RolUsuario.ADMIN }, [10]);
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('tiendaId');
  });

  it('un operador SIN tienda no ve ningún pedido (falla cerrado)', async () => {
    const { svc, findMany } = crearServicio({ vigentes: [], config });
    await svc.cancelarVencidos({ ...operador, tiendaId: undefined }, [10]);
    expect(findMany.mock.calls[0][0].where.tiendaId).toBe(-1);
  });

  it('el motivo por defecto lo entiende el cliente: es el texto del correo de cancelación', async () => {
    const { svc } = crearServicio({ vigentes: [{ id: 10 }], config });
    const cancelar = jest.spyOn(svc, 'cancelar').mockResolvedValue({} as never);

    await svc.cancelarVencidos(operador, [10]);

    const motivo = cancelar.mock.calls[0][2];
    expect(motivo).toMatch(/3 días/);
    expect(motivo).toMatch(/respuesta a nuestro recordatorio/);
    expect(motivo).not.toMatch(/vencid/i);
  });

  it('respeta el motivo que escribió el operador', async () => {
    const { svc } = crearServicio({ vigentes: [{ id: 10 }], config });
    const cancelar = jest.spyOn(svc, 'cancelar').mockResolvedValue({} as never);

    await svc.cancelarVencidos(operador, [10], '  Cliente avisó que ya no lo quiere  ');

    expect(cancelar.mock.calls[0][2]).toBe('Cliente avisó que ya no lo quiere');
  });

  it('un pedido que falla al cancelar no tumba a los demás', async () => {
    const { svc } = crearServicio({ vigentes: [{ id: 10 }, { id: 11 }], config });
    const cancelar = jest
      .spyOn(svc, 'cancelar')
      .mockRejectedValueOnce(new Error('El pedido cambió mientras se procesaba'))
      .mockResolvedValueOnce({} as never);

    const r = await svc.cancelarVencidos(operador, [10, 11]);

    expect(cancelar).toHaveBeenCalledTimes(2);
    expect(r.canceladas).toEqual([11]);
    expect(r.omitidas).toEqual([{ id: 10, razon: 'El pedido cambió mientras se procesaba' }]);
  });

  it('ids repetidos se cancelan una sola vez', async () => {
    const { svc } = crearServicio({ vigentes: [{ id: 10 }], config });
    const cancelar = jest.spyOn(svc, 'cancelar').mockResolvedValue({} as never);

    await svc.cancelarVencidos(operador, [10, 10, 10]);

    expect(cancelar).toHaveBeenCalledTimes(1);
  });
});

describe('MostradorService.enviarAPagar — la nota de historial usa la presencia', () => {
  it('un pedido de KIOSKO no se anota "sin aviso de llegada" (el cliente estaba en la tienda)', async () => {
    // Antes miraba solo el aviso, y a TODO pedido de kiosko le escribía "(sin aviso
    // de llegada del cliente)" aunque el cliente estuviera de pie enfrente.
    const { svc, cambiarEstado } = crearServicio({
      completo: { canalOrigen: 'KIOSKO', llegadaAnunciadaAt: null, llegadaDescartadaAt: null },
    });

    await svc.enviarAPagar(1, operador);

    expect(cambiarEstado.mock.calls[0][1].observacion).not.toMatch(/sin aviso/i);
  });

  it('un web sin aviso sí queda anotado, para poder auditar cuántas veces se salta el gate', async () => {
    const { svc, cambiarEstado } = crearServicio({
      completo: { canalOrigen: 'WEB', llegadaAnunciadaAt: null, llegadaDescartadaAt: null },
    });

    await svc.enviarAPagar(1, operador);

    expect(cambiarEstado.mock.calls[0][1].observacion).toMatch(/sin aviso de llegada/i);
  });
});
