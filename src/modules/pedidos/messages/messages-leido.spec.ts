import { RolUsuario } from '@prisma/client';
import { MessagesService } from './messages.service';

/**
 * F15 / oct 2026: la marca de agua de lectura del chat.
 *
 * Lo que estos tests fijan:
 *
 * 1. **Idempotencia y monotonía.** El watermark nunca decrementa. Dos pestañas
 *    abiertas que bumpean a la vez no pueden hacer retroceder la marca: el
 *    guard `OR` en el `where` del `updateMany` es lo que evita el clásico
 *    read-modify-write race.
 *
 * 2. **Clamp contra ids bogus.** Un payload manipulado que pida bumpear un id
 *    mayor al último mensaje real se recorta. Sin esto, un cliente podría
 *    marcar como leído un mensaje que todavía no existe y quedarse con los
 *    ticks ✓✓ en todos sus mensajes futuros.
 *
 * 3. **El lado sale del JWT, no del body.** CLIENTE bumpea la marca del cliente;
 *    cualquier rol de tienda bumpea la de tienda. Si esto se tomara del body,
 *    un cliente podría marcar como leídos los mensajes del asesor.
 *
 * 4. **entregado >= leído.** Un leído implica entregado. Oct 2026: el flag
 *    `entregado` del DTO se eliminó (el estado 'entregado' del frontend se
 *    quitó porque se alimentaba del watermark del lado equivocado), pero el
 *    invariante se conserva porque la columna sigue en BD.
 */

/** Prisma mockeado para `marcarLeido`. */
function crearServicio(opciones: { ultimoMensajeReal?: number | null } = {}) {
  const { ultimoMensajeReal = 10 } = opciones;

  const updateMany = jest.fn(async (_args: any) => ({ count: 1 }));
  const aggregate = jest.fn(async () => ({ _max: { id: ultimoMensajeReal } }));
  const findUnique = jest.fn(async () => ({
    usuarioId: 7,
    clienteUltimoMensajeLeidoId: 4,
    clienteUltimoMensajeEntregadoId: 4,
    tiendaUltimoMensajeLeidoId: 3,
  }));

  const prisma = {
    pedidoMensaje: { aggregate },
    pedido: { updateMany, findUnique },
  };

  const realtime = { emitToPedido: jest.fn(), emitToUser: jest.fn() };

  const svc = new MessagesService(
    prisma as never,
    { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, usuarioId: 7 }) } as never,
    realtime as never,
    {} as never, // mail
    {} as never, // config
    {} as never, // propuesta
    {} as never, // configuracion
    {} as never, // state
    {} as never, // ajuste
  );

  return { svc, updateMany, aggregate, realtime };
}

const cliente = { userId: 7, rol: RolUsuario.CLIENTE } as never;
const asesor = { userId: 9, rol: RolUsuario.VENTAS } as never;

/** Los `data` de cada llamada a `updateMany`, en orden. */
function datosDe(updateMany: jest.Mock) {
  return updateMany.mock.calls.map((c: any[]) => c[0].data);
}

describe('marcarLeido — el lado sale del JWT, no del body', () => {
  it('un CLIENTE avanza la marca del cliente', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, cliente);

    expect(datosDe(updateMany)).toContainEqual({ clienteUltimoMensajeLeidoId: 8 });
    // Y NO toca la del lado tienda.
    expect(datosDe(updateMany)).not.toContainEqual({ tiendaUltimoMensajeLeidoId: 8 });
  });

  it('un asesor avanza la marca de la tienda', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, asesor);

    expect(datosDe(updateMany)).toContainEqual({ tiendaUltimoMensajeLeidoId: 8 });
    expect(datosDe(updateMany)).not.toContainEqual({ clienteUltimoMensajeLeidoId: 8 });
  });

  it('el asesor NO avanza entregado (esa marca es del cliente)', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, asesor);

    expect(datosDe(updateMany)).not.toContainEqual({
      clienteUltimoMensajeEntregadoId: 8,
    });
  });
});

describe('marcarLeido — clamp contra ids bogus', () => {
  it('recorta el id al último mensaje real', async () => {
    const { svc, updateMany } = crearServicio({ ultimoMensajeReal: 10 });
    // El caller pide 9999, pero el último mensaje real es 10.
    await svc.marcarLeido(1, { ultimoMensajeId: 9999 }, cliente);

    expect(datosDe(updateMany)).toContainEqual({ clienteUltimoMensajeLeidoId: 10 });
    expect(datosDe(updateMany)).not.toContainEqual({ clienteUltimoMensajeLeidoId: 9999 });
  });

  it('sin mensajes en el pedido, respeta el id pedido (no hay contra qué clampear)', async () => {
    const { svc, updateMany } = crearServicio({ ultimoMensajeReal: null });
    await svc.marcarLeido(1, { ultimoMensajeId: 5 }, cliente);

    expect(datosDe(updateMany)).toContainEqual({ clienteUltimoMensajeLeidoId: 5 });
  });
});

describe('marcarLeido — idempotencia y monotonía', () => {
  it('el guard del where impide que la marca decremente', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, cliente);

    // El avance del watermark va con un OR que exige que la marca actual sea
    // null o MENOR que la nueva. Sin ese guard, dos pestañas concurrentes
    // podrían hacer retroceder la marca (el race read-modify-write).
    const llamada = updateMany.mock.calls[0][0] as any;
    expect(llamada.where.OR).toEqual([
      { clienteUltimoMensajeLeidoId: null },
      { clienteUltimoMensajeLeidoId: { lt: 8 } },
    ]);
  });

  it('un leído implica entregado: el cliente avanza las dos marcas', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, cliente);

    const datos = datosDe(updateMany);
    expect(datos).toContainEqual({ clienteUltimoMensajeLeidoId: 8 });
    expect(datos).toContainEqual({ clienteUltimoMensajeEntregadoId: 8 });
  });

  it('el avance de entregado también lleva su guard de monotonía', async () => {
    const { svc, updateMany } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, cliente);

    const llamadaEntregado = updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => 'clienteUltimoMensajeEntregadoId' in a.data);
    expect(llamadaEntregado.where.OR).toEqual([
      { clienteUltimoMensajeEntregadoId: null },
      { clienteUltimoMensajeEntregadoId: { lt: 8 } },
    ]);
  });
});

describe('marcarLeido — realtime', () => {
  it('emite mensaje.leido al room del pedido y al cliente', async () => {
    const { svc, realtime } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, cliente);

    expect(realtime.emitToPedido).toHaveBeenCalledWith(
      1,
      'mensaje.leido',
      expect.objectContaining({ pedidoId: 1, lado: 'cliente' }),
    );
    // Al cliente también, para que vea sus propios ticks actualizarse.
    expect(realtime.emitToUser).toHaveBeenCalledWith(7, 'mensaje.leido', expect.anything());
  });

  it('el payload lleva los tres watermarks releídos de la BD, no los calculados', async () => {
    const { svc, realtime } = crearServicio();
    await svc.marcarLeido(1, { ultimoMensajeId: 8 }, asesor);

    // Se relee el pedido después de escribir: emitir los valores calculados
    // dejaría al otro lado con una marca que no es la que quedó en BD.
    expect(realtime.emitToPedido).toHaveBeenCalledWith(
      1,
      'mensaje.leido',
      expect.objectContaining({
        lado: 'tienda',
        clienteUltimoMensajeLeidoId: 4,
        tiendaUltimoMensajeLeidoId: 3,
      }),
    );
  });
});
