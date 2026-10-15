import { CanalLlegada, EstadoPedido, ModoEntrega } from '@prisma/client';
import { KioskoLlegadaService } from './kiosko-llegada.service';

/**
 * El contrato de `reanudado` de `registrarAviso` (la escritura compartida por los
 * tres caminos: kiosko, app del cliente y mostrador):
 *
 *   `reanudado: true`  → el aviso es NUEVO: se escribió y se emitió.
 *   `reanudado: false` → el cliente ya estaba presente: no pasó nada y no hay ruido.
 *
 * F22 (oct 2026): antes `false` solo ocurría dentro de una ventana de 60 s, y pasada
 * la ventana el mismo cliente podía re-emitir el chime del mostrador cuantas veces
 * quisiera. Ahora la regla es la presencia: mientras haya cliente presente, avisar
 * de nuevo no hace nada.
 *
 * El flag elige el copy: con `false` el cliente ve "Ya avisamos al equipo" en vez
 * del mensaje del estado, porque no pasó nada nuevo.
 */
function crearServicio(pedido: Record<string, unknown>, updateManyCount = 1) {
  const updateMany = jest.fn(async (_args: unknown) => ({ count: updateManyCount }));
  const emitToTienda = jest.fn();
  const emitToPedido = jest.fn();
  const historialCreate = jest.fn().mockResolvedValue({});

  const prisma = {
    pedido: { findUnique: jest.fn().mockResolvedValue(pedido), updateMany },
    historialPedido: { create: historialCreate },
  };

  const svc = new KioskoLlegadaService(
    prisma as never,
    {} as never, // kioskoService
    { emitToTienda, emitToPedido } as never,
    { get: () => 'secreto-de-prueba-de-32-caracteres-minimo' } as never,
  );

  return { svc, updateMany, emitToTienda, emitToPedido, historialCreate };
}

/**
 * `emitToTienda` recibe DOS eventos distintos, así que filtrar por "fue
 * llamado" mezcla el aviso con la invalidación del monitor. Estos helpers
 * separan los dos para poder afirmar sobre cada uno.
 */
function avisos(tienda: jest.Mock) {
  return tienda.mock.calls.filter(([, evento]) => evento === 'pedido.llegada-anunciada');
}
function invalidaciones(tienda: jest.Mock) {
  return tienda.mock.calls.filter(([, evento]) => evento === 'monitor.invalidado');
}

const base = {
  id: 1,
  tiendaId: 5,
  numeroPedido: 'PD-2026-000123',
  clienteNombre: 'Juan Pérez',
  estado: EstadoPedido.REVISADO,
  modoEntrega: ModoEntrega.RECOGER_TIENDA,
  canalOrigen: 'WEB',
  fechaPedido: new Date(Date.now() - 3 * 60 * 60_000),
  llegadaAnunciadaAt: null,
  presenteDesdeAt: null,
  llegadaDescartadaAt: null,
  llegadaDescartes: 0,
  tienda: { nombre: 'Centro' },
};

const usuario = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: 'MOSTRADOR' as never,
  tiendaId: 5,
};

describe('registrarAviso — el contrato de reanudado', () => {
  it('primer aviso: se emite y es reanudado', async () => {
    const { svc, emitToTienda, historialCreate } = crearServicio({ ...base });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(avisos(emitToTienda)).toHaveLength(1);
    expect(avisos(emitToTienda)[0][2]).toEqual(
      expect.objectContaining({ canal: CanalLlegada.MOSTRADOR }),
    );
    // Y la TV/consola recomputan, porque el pedido acaba de entrar a la cola.
    expect(invalidaciones(emitToTienda)).toHaveLength(1);
    expect(historialCreate).toHaveBeenCalledTimes(1);
  });

  it('con el cliente ya presente: no escribe, no emite y no llena el historial', async () => {
    const hace10s = new Date(Date.now() - 10_000);
    const { svc, updateMany, emitToTienda, historialCreate } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace10s,
      presenteDesdeAt: hace10s,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(avisos(emitToTienda)).toHaveLength(0);
    // Tampoco se invalida el monitor: nada cambió.
    expect(invalidaciones(emitToTienda)).toHaveLength(0);
    // F22: ni una fila de auditoría por cada toque repetido del botón.
    expect(historialCreate).not.toHaveBeenCalled();
  });

  it('pasada MUCHO más de un minuto, avisar de nuevo sigue sin hacer nada', async () => {
    // El comportamiento viejo: tras 60 s el mismo aviso se re-emitía. Era la vía
    // por la que "Avisar de nuevo" hacía sonar la TV a voluntad.
    const hace2h = new Date(Date.now() - 2 * 60 * 60_000);
    const { svc, emitToTienda } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace2h,
      presenteDesdeAt: hace2h,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(false);
    expect(avisos(emitToTienda)).toHaveLength(0);
  });

  it('un aviso descartado se re-emite de inmediato y reinicia la espera', async () => {
    const hace2h = new Date(Date.now() - 2 * 60 * 60_000);
    const { svc, emitToTienda, updateMany } = crearServicio({
      ...base,
      llegadaAnunciadaAt: hace2h,
      presenteDesdeAt: hace2h,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 1,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(avisos(emitToTienda)).toHaveLength(1);
    const { data } = updateMany.mock.calls[0][0] as any;
    // No hereda las 2 horas del aviso anterior.
    expect(Date.now() - data.presenteDesdeAt.getTime()).toBeLessThan(5_000);
  });

  it('el operador SÍ puede marcar la llegada tras dos descartes (el límite es solo del botón web)', async () => {
    // Un cliente que avisó en falso dos veces ya no se cree por web. Pero si el
    // operador lo tiene enfrente, el operador lo avala.
    const { svc } = crearServicio({
      ...base,
      llegadaDescartadaAt: new Date(),
      llegadaDescartes: 2,
    });

    await expect(svc.confirmarDesdeMostrador(1, usuario)).resolves.toMatchObject({
      reanudado: true,
    });
  });

  it('marcar desde mostrador escribe el canal y el autor', async () => {
    const { svc, updateMany } = crearServicio({ ...base });

    await svc.confirmarDesdeMostrador(1, usuario);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          llegadaAnunciadaCanal: CanalLlegada.MOSTRADOR,
          llegadaAnunciadaPor: 'Ana Mostrador',
          llegadaAnunciadaKioskoId: null,
        }),
      }),
    );
  });

  /**
   * Oct 2026: el operador SÍ puede marcar la llegada de un pedido que todavía no
   * estaba listo. Ese era el hueco: el cliente llega sin ticket y sin folio, su
   * pedido sigue en bodega, y el operador recibía un 409 con el cliente enfrente.
   *
   * El pedido NO entra a la cola del mostrador: la llegada queda registrada y el
   * gate (estado = REVISADO) sigue mandando. Cuando bodega termine, el pedido
   * aparece con su badge EN TIENDA y su espera contando desde que el cliente llegó.
   */
  it('SÍ acepta marcar la llegada de un pedido que aún está en bodega', async () => {
    const { svc, emitToTienda } = crearServicio({
      ...base,
      estado: EstadoPedido.EN_REVISION,
    });

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    expect(r.entraACola).toBe(false);
    // Sí emite: la consola de bodega tiene que enterarse de que hay un cliente
    // esperando y priorizar ese pedido.
    expect(emitToTienda).toHaveBeenCalledWith(
      5,
      'pedido.llegada-anunciada',
      expect.objectContaining({ estado: EstadoPedido.EN_REVISION }),
    );
  });

  it('rechaza marcar la llegada de un pedido ya entregado', async () => {
    const { svc, emitToTienda } = crearServicio({
      ...base,
      estado: EstadoPedido.ENTREGADO,
    });

    await expect(svc.confirmarDesdeMostrador(1, usuario)).rejects.toThrow(/entregado/i);
    expect(emitToTienda).not.toHaveBeenCalled();
  });
});

/**
 * F22: la reacción que mueve un pedido con propuesta pendiente al área de entrega
 * cuando el cliente llega. KioskoModule no puede importar PedidosModule (ciclo), así
 * que el módulo dueño de la máquina de estados se registra como oyente.
 */
describe('registrarAviso — reacciones al aviso', () => {
  it('corre las reacciones cuando el aviso es NUEVO, con el estado y quién avisó', async () => {
    const { svc } = crearServicio({ ...base, estado: EstadoPedido.ESPERANDO_APROBACION });
    const reaccion = jest.fn().mockResolvedValue(undefined);
    svc.registrarReaccion(reaccion);

    await svc.confirmarDesdeMostrador(1, usuario);

    expect(reaccion).toHaveBeenCalledTimes(1);
    expect(reaccion).toHaveBeenCalledWith(
      expect.objectContaining({
        pedidoId: 1,
        estado: EstadoPedido.ESPERANDO_APROBACION,
        canal: CanalLlegada.MOSTRADOR,
        por: 'Ana Mostrador',
        usuario,
      }),
    );
  });

  it('NO corre las reacciones si el cliente ya estaba presente', async () => {
    const ahora = new Date();
    const { svc } = crearServicio({
      ...base,
      llegadaAnunciadaAt: ahora,
      presenteDesdeAt: ahora,
    });
    const reaccion = jest.fn();
    svc.registrarReaccion(reaccion);

    await svc.confirmarDesdeMostrador(1, usuario);

    expect(reaccion).not.toHaveBeenCalled();
  });

  it('una reacción que falla NO deshace el aviso (ya quedó guardado)', async () => {
    const { svc } = crearServicio({ ...base });
    svc.registrarReaccion(jest.fn().mockRejectedValue(new Error('transición no permitida')));
    const segunda = jest.fn().mockResolvedValue(undefined);
    svc.registrarReaccion(segunda);

    const r = await svc.confirmarDesdeMostrador(1, usuario);

    expect(r.reanudado).toBe(true);
    // Y una reacción rota no impide que corran las demás.
    expect(segunda).toHaveBeenCalled();
  });
});
