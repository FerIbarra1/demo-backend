import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CanalLlegada, EstadoPedido, RolUsuario } from '@prisma/client';
import { MAX_LLAMADAS_FALLIDAS, PresenciaService } from './presencia.service';

/**
 * F22 (oct 2026): todo lo que cambia la PRESENCIA del cliente y necesita la máquina
 * de estados. Los huecos que cierra:
 *
 *  - descartar el aviso de un pedido YA LLAMADO lo dejaba atascado en `EN_ATENCION`
 *    (ni la cola ni la TV lo mostraban, porque exigen cliente presente);
 *  - un pedido de kiosko cuyo cliente se fue no tenía forma de salir de la cola;
 *  - un pedido que esperaba aprobación y cuyo cliente llegaba a la tienda era
 *    invisible.
 */

const operador = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

const presenteWeb = {
  id: 1,
  tiendaId: 5,
  numeroPedido: 'PD-2026-000123',
  estado: EstadoPedido.REVISADO,
  canalOrigen: 'WEB',
  llegadaAnunciadaAt: new Date(Date.now() - 600_000),
  llegadaDescartadaAt: null,
  llamadasFallidas: 0,
  usuarioId: 7,
};

function crearServicio(pedido: Record<string, unknown> | null = presenteWeb) {
  const update = jest.fn().mockResolvedValue({});
  const historialCreate = jest.fn().mockResolvedValue({});
  const txUpdate = jest.fn().mockResolvedValue({});

  const prisma = {
    pedido: { findUnique: jest.fn().mockResolvedValue(pedido), update },
    historialPedido: { create: historialCreate },
  };
  // La transición ejecuta los `efectos` dentro de "su" transacción.
  const cambiarEstado = jest.fn(async (_id: number, _dto: any, _u: any, opts: any) => {
    if (opts?.efectos) await opts.efectos({ pedido: { update: txUpdate } });
    return {};
  });
  const access = { cargarYValidar: jest.fn().mockResolvedValue({}) };
  const realtime = { emitToTienda: jest.fn(), emitToPedido: jest.fn() };
  const registrarReaccion = jest.fn();

  const svc = new PresenciaService(
    prisma as never,
    { cambiarEstado } as never,
    access as never,
    realtime as never,
    { registrarReaccion } as never,
  );
  return {
    svc,
    update,
    txUpdate,
    historialCreate,
    cambiarEstado,
    access,
    realtime,
    registrarReaccion,
  };
}

describe('PresenciaService.descartar', () => {
  it('descarta el aviso de un pedido web y avisa al cliente por realtime', async () => {
    const { svc, update, realtime, historialCreate } = crearServicio();

    const r = await svc.descartar(1, operador);

    expect(r).toEqual({ ok: true, pedidoId: 1 });
    const { data } = update.mock.calls[0][0];
    expect(data.llegadaDescartadaAt).toBeInstanceOf(Date);
    // Cuenta como descarte: a la segunda el botón web del cliente se cierra.
    expect(data.llegadaDescartes).toEqual({ increment: 1 });
    expect(data.llegadaDescartadaPor).toEqual({ connect: { id: 3 } });
    // El cliente se entera: antes veía "Ya avisamos que llegaste" sin saber que lo
    // habían quitado de la cola.
    expect(realtime.emitToPedido).toHaveBeenCalledWith(1, 'pedido.llegada-descartada', {
      pedidoId: 1,
      numeroPedido: 'PD-2026-000123',
      motivo: 'MOSTRADOR',
    });
    // La TV y la consola dejan de mostrarlo, y queda en el historial.
    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'monitor.invalidado', { pedidoId: 1 });
    expect(historialCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pedidoId: 1,
        estadoAnterior: EstadoPedido.REVISADO,
        estadoNuevo: EstadoPedido.REVISADO,
        observacion: expect.stringMatching(/descartado.*Ana Mostrador/),
      }),
    });
  });

  it('funciona con un pedido de KIOSKO (no tiene llegadaAnunciadaAt)', async () => {
    // El hueco: descartar exigía `llegadaAnunciadaAt`. Un cliente de kiosko que se
    // iba no tenía forma de salir de la cola.
    const { svc, update } = crearServicio({
      ...presenteWeb,
      canalOrigen: 'KIOSKO',
      llegadaAnunciadaAt: null,
    });

    await expect(svc.descartar(1, operador)).resolves.toMatchObject({ ok: true });
    expect(update).toHaveBeenCalled();
  });

  it('rechaza un pedido cuyo cliente no está presente', async () => {
    const { svc, update } = crearServicio({ ...presenteWeb, llegadaAnunciadaAt: null });

    await expect(svc.descartar(1, operador)).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('rechaza descartar dos veces el mismo aviso', async () => {
    const { svc } = crearServicio({ ...presenteWeb, llegadaDescartadaAt: new Date() });
    await expect(svc.descartar(1, operador)).rejects.toThrow(/no tiene al cliente/i);
  });

  describe('con el pedido ya LLAMADO (EN_ATENCION)', () => {
    const llamado = { ...presenteWeb, estado: EstadoPedido.EN_ATENCION };

    it('lo regresa a REVISADO en la MISMA transacción, en vez de dejarlo huérfano', async () => {
      // El bug: descartar no movía el estado. El pedido seguía en EN_ATENCION y
      // como la cola y la TV exigen cliente presente, quedaba invisible en todas
      // partes — solo se encontraba con el buscador.
      const { svc, cambiarEstado, txUpdate, update } = crearServicio(llamado);

      await svc.descartar(1, operador);

      expect(cambiarEstado).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ nuevoEstado: EstadoPedido.REVISADO }),
        operador,
        expect.objectContaining({ invalidarMonitor: true }),
      );
      // El cambio de columnas va DENTRO de la transición (efectos), no aparte.
      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ llegadaDescartadaAt: expect.any(Date) }),
      });
      expect(update).not.toHaveBeenCalled();
    });

    it('sin correo: ya estaba "listo en tienda"', async () => {
      const { svc, cambiarEstado } = crearServicio(llamado);
      await svc.descartar(1, operador);
      expect(cambiarEstado.mock.calls[0][3]).toEqual(
        expect.objectContaining({ sinNotificar: true }),
      );
    });
  });

  it('el sistema (userId 0) no se registra como FK de quien descartó', async () => {
    // `llegadaDescartadaPorId` es FK a usuarios: conectar al usuario 0 violaría la
    // restricción.
    const { svc, update } = crearServicio();
    await svc.descartar(1, { userId: 0, nombre: 'Sistema', rol: RolUsuario.ADMIN });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('llegadaDescartadaPor');
  });

  it('valida el acceso antes de tocar nada', async () => {
    const { svc, access } = crearServicio();
    await svc.descartar(1, operador);
    expect(access.cargarYValidar).toHaveBeenCalledWith(1, operador);
  });
});

describe('PresenciaService.retirarPorCliente — "ya no estoy aquí"', () => {
  it('retira el aviso propio SIN contarlo como descarte', async () => {
    // No fue una falsa alarma que el mostrador tuvo que corregir: fue el propio
    // cliente corrigiéndose. Contarlo cerraría su botón por equivocarse una vez.
    const { svc, update, historialCreate, realtime } = crearServicio();

    await svc.retirarPorCliente(1, 7);

    const { data } = update.mock.calls[0][0];
    expect(data.llegadaDescartadaAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('llegadaDescartes');
    expect(data.llegadaDescartadaPorId).toBeNull();
    expect(historialCreate.mock.calls[0][0].data.observacion).toMatch(/retiró su aviso/i);
    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'monitor.invalidado', { pedidoId: 1 });
  });

  it('solo el dueño del pedido puede retirarlo', async () => {
    const { svc, update } = crearServicio({ ...presenteWeb, usuarioId: 99 });
    await expect(svc.retirarPorCliente(1, 7)).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('no se puede retirar el aviso mientras ya lo están atendiendo', async () => {
    const { svc, update } = crearServicio({ ...presenteWeb, estado: EstadoPedido.EN_ATENCION });
    await expect(svc.retirarPorCliente(1, 7)).rejects.toThrow(/atendiendo/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('sin aviso vigente no hay nada que retirar', async () => {
    const { svc } = crearServicio({ ...presenteWeb, llegadaAnunciadaAt: null });
    await expect(svc.retirarPorCliente(1, 7)).rejects.toThrow(BadRequestException);
  });
});

describe('PresenciaService.noSePresento', () => {
  const llamado = { ...presenteWeb, estado: EstadoPedido.EN_ATENCION };

  it('la PRIMERA vez pasa al FINAL de la cola (su lugar es ahora)', async () => {
    // No es "devolver a la cola": esa es para un error del operador y conserva el
    // lugar. Esta es para un cliente que tenía turno y no lo usó.
    const { svc, txUpdate, cambiarEstado } = crearServicio(llamado);

    const r = await svc.noSePresento(1, operador);

    expect(r).toEqual({ ok: true, pedidoId: 1, descartado: false });
    expect(cambiarEstado).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ nuevoEstado: EstadoPedido.REVISADO }),
      operador,
      expect.anything(),
    );
    const { data } = txUpdate.mock.calls[0][0];
    expect(data.llamadasFallidas).toBe(1);
    expect(data.presenteDesdeAt).toBeInstanceOf(Date);
    // Todavía está presente: solo cambió de lugar.
    expect(data).not.toHaveProperty('llegadaDescartadaAt');
  });

  it(`a la llamada ${MAX_LLAMADAS_FALLIDAS} en vano se DESCARTA su aviso`, async () => {
    const { svc, txUpdate, realtime } = crearServicio({ ...llamado, llamadasFallidas: 1 });

    const r = await svc.noSePresento(1, operador);

    expect(r.descartado).toBe(true);
    const { data } = txUpdate.mock.calls[0][0];
    expect(data.llamadasFallidas).toBe(2);
    expect(data.llegadaDescartadaAt).toBeInstanceOf(Date);
    expect(data.llegadaDescartes).toEqual({ increment: 1 });
    // El cliente se entera de que perdió su turno.
    expect(realtime.emitToPedido).toHaveBeenCalledWith(
      1,
      'pedido.llegada-descartada',
      expect.objectContaining({ motivo: 'NO_SE_PRESENTO' }),
    );
  });

  it('la primera vez NO avisa al cliente de un descarte que no ocurrió', async () => {
    const { svc, realtime } = crearServicio(llamado);
    await svc.noSePresento(1, operador);
    expect(realtime.emitToPedido).not.toHaveBeenCalled();
  });

  it('solo aplica a un pedido ya llamado', async () => {
    const { svc, cambiarEstado } = crearServicio({ ...presenteWeb, estado: EstadoPedido.REVISADO });
    await expect(svc.noSePresento(1, operador)).rejects.toThrow(/ya llamado/i);
    expect(cambiarEstado).not.toHaveBeenCalled();
  });

  it('el historial dice qué pasó (al final de la cola / aviso descartado)', async () => {
    const primera = crearServicio(llamado);
    await primera.svc.noSePresento(1, operador);
    expect(primera.cambiarEstado.mock.calls[0][1].observacion).toMatch(/final de la cola/i);

    const segunda = crearServicio({ ...llamado, llamadasFallidas: 1 });
    await segunda.svc.noSePresento(1, operador);
    expect(segunda.cambiarEstado.mock.calls[0][1].observacion).toMatch(/descartó su aviso/i);
  });
});

describe('PresenciaService.alLlegarCliente — propuesta pendiente', () => {
  const reaccion = (estado: EstadoPedido, usuario?: typeof operador) => ({
    pedidoId: 1,
    tiendaId: 5,
    estado,
    canal: CanalLlegada.WEB,
    por: 'App del cliente',
    usuario,
  });

  it('se registra como oyente del aviso al arrancar', () => {
    const { svc, registrarReaccion } = crearServicio();
    svc.onModuleInit();
    expect(registrarReaccion).toHaveBeenCalledTimes(1);
  });

  it('mueve ESPERANDO_APROBACION al área de entrega, sin correo', async () => {
    // El comentario de `destinoTrasSurtidoIncompleto` decía "avisar llegada mueve el
    // pedido a REVISADO"; ese código nunca existió, así que el cliente con una
    // propuesta pendiente que llegaba a la tienda era invisible.
    const { svc, cambiarEstado } = crearServicio();

    await svc.alLlegarCliente(reaccion(EstadoPedido.ESPERANDO_APROBACION));

    expect(cambiarEstado).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        nuevoEstado: EstadoPedido.REVISADO,
        observacion: expect.stringMatching(/propuesta pendiente/i),
      }),
      // Nadie del personal avisó: actúa el sistema.
      expect.objectContaining({ userId: 0, nombre: 'Sistema' }),
      // Decirle "tu pedido ya está listo" a quien está de pie en el mostrador es ruido.
      expect.objectContaining({ sinNotificar: true, invalidarMonitor: true }),
    );
  });

  it('si avisó un operador, la transición queda a SU nombre', async () => {
    const { svc, cambiarEstado } = crearServicio();
    await svc.alLlegarCliente(reaccion(EstadoPedido.ESPERANDO_APROBACION, operador));
    expect(cambiarEstado.mock.calls[0][2]).toBe(operador);
  });

  it.each([
    EstadoPedido.SOLICITADO,
    EstadoPedido.EN_REVISION,
    EstadoPedido.EN_ASESORIA,
    EstadoPedido.REVISADO,
    EstadoPedido.PENDIENTE_PAGO,
    EstadoPedido.PAGADO,
  ])('NO mueve un pedido en %s: el aviso es solo una señal', async (estado) => {
    // Solo el que espera aprobación cambia de lugar; en los demás el aviso se
    // limita a registrar la presencia.
    const { svc, cambiarEstado } = crearServicio();
    await svc.alLlegarCliente(reaccion(estado));
    expect(cambiarEstado).not.toHaveBeenCalled();
  });
});
