import { EstadoPedido, EstadoSurtido, Prisma, RolUsuario } from '@prisma/client';
import { MostradorService } from './mostrador.service';
import type { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026 (propuestas, decisión 4 del dueño): el ajuste de MOSTRADOR que solo
 * quita o baja piezas se resuelve EN EL LUGAR y esas piezas pasan a REPOSICIÓN.
 *
 * Reemplaza a `ajuste-sin-reposicion.spec`, que fijaba la regla contraria ("un
 * ajuste de mostrador NO genera reposición, el pedido vuelve a bodega y el
 * bodeguero saca las piezas con el checklist"). Esa regla sigue valiendo para
 * VENTAS; para mostrador se revirtió porque el cliente está de pie enfrente y
 * mandar el pedido a la cola de bodega solo lo hacía esperar.
 *
 * El reporte del piso que originó la regla vieja sigue siendo cierto y también se
 * fija aquí: "los productos que se quitaron y que ya puse en el anaquel vuelven a
 * salir en reposición". Por eso las piezas que el operador saca se suman a
 * `piezasRetiradas` en el MISMO update: el checklist de bodega no las repite.
 */

const usuario: UserContext = {
  userId: 3,
  nombre: 'Ana Mostrador',
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
};

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 10,
    cantidadSurtida: 10,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(1000),
    ...over,
  };
}

function crearServicio(items: any[], opts: { estado?: EstadoPedido } = {}) {
  const estado = opts.estado ?? EstadoPedido.REVISADO;
  const pedidoCompleto = {
    id: 1,
    tiendaId: 5,
    estado,
    descuento: new Prisma.Decimal(0),
    impuestos: new Prisma.Decimal(0),
    items,
  };

  const tx = {
    pedido: { update: jest.fn(async () => ({})) },
    pedidoPropuesta: { updateMany: jest.fn(async () => ({ count: 0 })) },
    historialPedido: { create: jest.fn(async () => ({})) },
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => items.find((i) => i.id === where.id) ?? null),
      // Honra `cancelada: false` (lo pide el recálculo de totales); sin ese filtro
      // devuelve TODAS las líneas, también las canceladas, como la BD.
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.cancelada === false ? items.filter((i) => !i.cancelada) : items,
      ),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => items.filter((i) => !i.cancelada).length),
    },
  };

  const prisma = { pedido: { findUnique: jest.fn(async () => pedidoCompleto) } };

  // Lo que la transición dejó escrito en el historial. Se lee DESPUÉS de correr los
  // `efectos`, igual que la máquina de estados real: el texto lleva el conteo de
  // cambios aplicados, que solo se conoce ahí adentro.
  const transicion: { dto?: any; opts?: any; observacion?: string } = {};
  const cambiarEstado = jest.fn(async (_id: number, dto: any, _u: any, optsEstado: any) => {
    transicion.dto = dto;
    transicion.opts = optsEstado;
    if (optsEstado?.efectos) await optsEstado.efectos(tx);
    transicion.observacion = dto.observacion;
    return { id: 1, estado: dto.nuevoEstado };
  });

  const reposicion = {
    registrarQuitadasEnMostrador: jest.fn(async () => undefined),
    crearDesdePedido: jest.fn(),
    crearDesdeAjuste: jest.fn(),
  };
  const realtime = { emitToTienda: jest.fn() };

  const svc = new MostradorService(
    prisma as never,
    { cambiarEstado } as never,
    { cargarYValidar: jest.fn(async () => ({ id: 1, estado })) } as never,
    reposicion as never,
    realtime as never,
    { columnaParaPedido: jest.fn(async () => 'lista1') } as never,
    { confirmarDesdeMostrador: jest.fn(async () => ({})) } as never,
    {} as never, // presencia (F22)
    { resolverParaLlamar: jest.fn().mockResolvedValue(null) } as never, // mostradores (F22)
    { get: jest.fn() } as never, // config
  );

  return { svc, tx, reposicion, realtime, cambiarEstado, transicion };
}

/** El `data` del update de una línea. */
function dataDe(tx: ReturnType<typeof crearServicio>['tx'], id: number) {
  const llamada = (tx.itemPedido.update as jest.Mock).mock.calls.find(
    ([a]: any) => a.where.id === id,
  );
  return llamada![0].data;
}

describe('el cliente solo QUITA o BAJA: se resuelve en el lugar y pasa a reposición', () => {
  it('quitar una línea: el pedido NO va a bodega y sus piezas pasan a reposición', async () => {
    const { svc, tx, reposicion, cambiarEstado, transicion } = crearServicio([
      item({ id: 1 }),
      item({ id: 2 }),
    ]);

    const r = await svc.ajustar(1, usuario, 'Ya no quiere el primero', [
      { tipo: 'no-disponible', itemId: 1 } as never,
    ]);

    // La línea quedó cancelada conservando el hallazgo (F20) y el operador ya sacó
    // las 10 piezas: se suman al contador en el mismo update.
    const upd = dataDe(tx, 1);
    expect(upd.cancelada).toBe(true);
    expect(upd.cantidadSurtida).toBe(10);
    expect(upd.piezasRetiradas).toEqual({ increment: 10 });

    expect(reposicion.registrarQuitadasEnMostrador).toHaveBeenCalledWith(tx, 1, [
      { itemId: 1, cantidad: 10 },
    ]);

    // Se queda donde está: el destino ES el estado actual y no se toca bodega.
    expect(cambiarEstado).toHaveBeenCalledTimes(1);
    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.REVISADO);
    expect(transicion.opts.permitirMismoEstado).toBe(true);
    expect(transicion.opts.asignacion).toBe('mantener');
    expect(transicion.opts.reloj).toBe('mantener');

    expect(r.vaABodega).toBe(false);
    expect(r.piezasAReposicion).toBe(10);
  });

  it('bajar la cantidad: el sobrante pasa a reposición y el hallazgo sobrevive', async () => {
    const { svc, tx, reposicion, transicion } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    const r = await svc.ajustar(1, usuario, 'Solo quiere 7', [
      { tipo: 'parcial', itemId: 1, cantidad: 7 } as never,
    ]);

    const upd = dataDe(tx, 1);
    expect(upd.cantidad).toBe(7);
    // "Hay 10": el hallazgo físico no se pisa con la decisión (F21).
    expect(upd.cantidadSurtida).toBe(10);
    expect(upd.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    expect(upd.piezasRetiradas).toEqual({ increment: 3 });

    expect(reposicion.registrarQuitadasEnMostrador).toHaveBeenCalledWith(tx, 1, [
      { itemId: 1, cantidad: 3 },
    ]);
    expect(transicion.opts.asignacion).toBe('mantener');
    expect(r.vaABodega).toBe(false);
    expect(r.piezasAReposicion).toBe(3);
  });

  it('no repite lo que ya salió: una línea cuyas piezas ya se retiraron no entra de nuevo', async () => {
    // El reporte del piso, ahora por la puerta del mostrador: ya se sacaron las 4
    // (`piezasRetiradas`), así que quitar la línea otra vez no tiene nada que listar.
    const { svc, tx, reposicion } = crearServicio([
      item({ id: 1 }),
      item({ id: 2, cantidadSurtida: 4, cantidad: 4, piezasRetiradas: 4 }),
    ]);

    await svc.ajustar(1, usuario, 'Quita el segundo', [
      { tipo: 'no-disponible', itemId: 2 } as never,
    ]);

    expect(dataDe(tx, 2).piezasRetiradas).toBeUndefined();
    expect(reposicion.registrarQuitadasEnMostrador).not.toHaveBeenCalled();
  });

  it('descuenta lo ya retirado al bajar: 5 encontradas, 2 sacadas, baja de 3 a 1', async () => {
    const { svc, tx, reposicion } = crearServicio([
      item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 }),
      item({ id: 2 }),
    ]);

    await svc.ajustar(1, usuario, 'Baja a 1', [
      { tipo: 'parcial', itemId: 1, cantidad: 1 } as never,
    ]);

    // En la bolsa había 3; quedan 1, se sacan 2 (no 4).
    expect(dataDe(tx, 1).piezasRetiradas).toEqual({ increment: 2 });
    expect(reposicion.registrarQuitadasEnMostrador).toHaveBeenCalledWith(tx, 1, [
      { itemId: 1, cantidad: 2 },
    ]);
  });

  it('deja en el historial el conteo REAL de cambios, no los propuestos', async () => {
    // F21 decía registrarlo y no lo hacía: la observación se copiaba por valor al
    // DTO antes de que los `efectos` la actualizaran.
    const { svc, transicion } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Quita uno', [
      { tipo: 'no-disponible', itemId: 1 } as never,
      { tipo: 'completo', itemId: 2 } as never,
    ]);

    expect(transicion.observacion).toMatch(/\(1 cambio\(s\)\)/);
    expect(transicion.observacion).toMatch(/sin pasar por bodega/);
  });

  it('sin transición el historial lo escribe el servicio, con el texto de lo ocurrido', async () => {
    // `cambiarEstado` no escribe historial cuando el estado no cambia.
    const { svc, tx } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Quita uno', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(tx.historialPedido.create).toHaveBeenCalledTimes(1);
    const { data } = (tx.historialPedido.create as jest.Mock).mock.calls[0][0];
    expect(data.estadoAnterior).toBe(EstadoPedido.REVISADO);
    expect(data.estadoNuevo).toBe(EstadoPedido.REVISADO);
    expect(data.usuarioId).toBe(3);
    expect(data.observacion).toMatch(/Ana Mostrador/);
  });

  it('avisa a bodega con un evento propio, después del commit', async () => {
    // Sin cambio de estado no sale `pedido.estado`, y la lista de reposición se
    // quedaría con la foto vieja hasta un F5.
    const { svc, realtime } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Quita uno', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(realtime.emitToTienda).toHaveBeenCalledWith(5, 'reposicion.creada', {
      pedidoId: 1,
      piezas: 10,
    });
  });
});

describe('el pedido se queda donde el cliente lo está esperando', () => {
  it('ESPERANDO_APROBACION pasa a REVISADO: el cliente ya está enfrente', async () => {
    const { svc, tx, transicion } = crearServicio([item({ id: 1 }), item({ id: 2 })], {
      estado: EstadoPedido.ESPERANDO_APROBACION,
    });

    await svc.ajustar(1, usuario, 'Quita uno', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.REVISADO);
    // Esta SÍ es una transición: el historial lo escribe la máquina de estados.
    expect(tx.historialPedido.create).not.toHaveBeenCalled();
    // Y sin correo: "tu pedido ya está listo en tienda" a quien está de pie ahí.
    expect(transicion.opts.sinNotificar).toBe(true);
  });

  it('EN_ATENCION se queda en EN_ATENCION: la llamada del cliente no se pierde', async () => {
    const { svc, transicion } = crearServicio([item({ id: 1 }), item({ id: 2 })], {
      estado: EstadoPedido.EN_ATENCION,
    });

    await svc.ajustar(1, usuario, 'Quita uno', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_ATENCION);
    expect(transicion.opts.permitirMismoEstado).toBe(true);
  });

  it('la propuesta que esperaba queda SUPERADA aunque no pase por bodega', async () => {
    const { svc, tx } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.ajustar(1, usuario, 'Quita uno', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(tx.pedidoPropuesta.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ estado: 'SUPERADA' }) }),
    );
  });
});

describe('hay algo que SURTIR: el pedido viaja a bodega', () => {
  it('subir sobre lo que ya salió de la bolsa vuelve a bodega a re-verificar', async () => {
    // Había 5, ya salieron 2 (en la bolsa 3) y ahora el cliente quiere 4. Las 2 que
    // salieron ya están en el anaquel: el item no puede quedar COMPLETO.
    const { svc, tx, reposicion, transicion } = crearServicio([
      item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 }),
      item({ id: 2 }),
    ]);

    const r = await svc.ajustar(1, usuario, 'Ahora quiere 4', [
      { tipo: 'parcial', itemId: 1, cantidad: 4 } as never,
    ]);

    const upd = dataDe(tx, 1);
    expect(upd.cantidad).toBe(4);
    expect(upd.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    // Decisión 2: se rebasa a lo que hay en la bolsa (5 − 2 = 3); bodega verifica solo
    // la pieza de más, y el piso impide marcar menos de 3.
    expect(upd.cantidadSurtida).toBe(3);
    expect(upd.piezasBase).toBe(3);
    expect(upd.piezasRetiradas).toBe(0);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
    expect(transicion.opts.asignacion).toBe('limpiar');
    expect(transicion.opts.reloj).toBe('reanudar');
    expect(transicion.opts.permitirMismoEstado).toBe(false);
    expect(reposicion.registrarQuitadasEnMostrador).not.toHaveBeenCalled();
    expect(r.vaABodega).toBe(true);
  });

  it('agregar un producto va a bodega', async () => {
    const { svc, tx, transicion } = crearServicio([item({ id: 1 })]);
    (tx as any).precioCO = {
      findUnique: jest.fn(async () => ({
        id: 77,
        productoId: 9,
        tiendaId: 5,
        precio: new Prisma.Decimal(50),
        lista1: new Prisma.Decimal(50),
        lista2: new Prisma.Decimal(40),
        producto: { nombre: 'Playera', codigo: 'PL-1' },
        corrida: { nombre: 'Adulto' },
        talla: { nombre: 'M' },
        color: { nombre: 'Negro' },
      })),
    };

    const r = await svc.ajustar(1, usuario, 'Agrega una playera', [
      { tipo: 'agregado', precioCOId: 77, cantidad: 2 } as never,
    ]);

    // Un producto nuevo nace PENDIENTE: nadie lo ha visto en el anaquel.
    const creado = (tx.itemPedido.create as jest.Mock).mock.calls[0][0].data;
    expect(creado.estadoSurtido).toBe('PENDIENTE');
    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
    expect(r.vaABodega).toBe(true);
  });

  it('una tanda MIXTA (quita una línea y sube otra) va a bodega y lo quitado igual pasa a reposición', async () => {
    // Regla del piso: lo que quitas, lo sacas tú — no depende de si la tanda trae
    // otra cosa. `piezasRetiradas` ya cuenta esas piezas, así que el checklist de
    // bodega no se las vuelve a pedir.
    const { svc, tx, reposicion, transicion } = crearServicio([
      item({ id: 1 }),
      item({ id: 2, cantidad: 3, cantidadSurtida: 3 }),
    ]);

    const r = await svc.ajustar(1, usuario, 'Quita el 1 y sube el 2', [
      { tipo: 'no-disponible', itemId: 1 } as never,
      { tipo: 'parcial', itemId: 2, cantidad: 5 } as never,
    ]);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
    expect(dataDe(tx, 1).piezasRetiradas).toEqual({ increment: 10 });
    expect(reposicion.registrarQuitadasEnMostrador).toHaveBeenCalledWith(tx, 1, [
      { itemId: 1, cantidad: 10 },
    ]);
    expect(r.vaABodega).toBe(true);
    expect(r.piezasAReposicion).toBe(10);
  });

  it('un pedido con una línea PENDIENTE sin tocar tampoco se queda en el área de entrega', async () => {
    // Llegaría al ERP cobrando mercancía que bodega nunca vio.
    const { svc, transicion } = crearServicio([
      item({ id: 1 }),
      item({ id: 2, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE }),
    ]);

    await svc.ajustar(1, usuario, 'Quita el 1', [{ tipo: 'no-disponible', itemId: 1 } as never]);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
  });

  it('sin items (solo la nota) conserva el comportamiento de siempre: a bodega', async () => {
    const { svc, transicion, reposicion } = crearServicio([item({ id: 1 })]);

    const r = await svc.ajustar(1, usuario, 'El cliente quiere algo distinto');

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
    expect(reposicion.registrarQuitadasEnMostrador).not.toHaveBeenCalled();
    expect(r.vaABodega).toBe(true);
  });

  it('con todos los items "completo" no hay nada que aplicar: también a bodega', async () => {
    const { svc, transicion } = crearServicio([item({ id: 1 })]);

    await svc.ajustar(1, usuario, 'Sin cambios', [{ tipo: 'completo', itemId: 1 } as never]);

    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
  });
});

describe('REPONER (decisión 3): una línea que bodega no encontró vuelve al pedido', () => {
  /** Lo que deja `datosDeFaltaDeBodega()`. */
  const sinExistencia = (over: Partial<Record<string, unknown>> = {}) =>
    item({
      id: 2,
      cantidad: 5,
      cantidadSurtida: 0,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cancelada: true,
      subtotal: new Prisma.Decimal(500),
      ...over,
    });

  it('vuelve PENDIENTE y sin tocar lo pedido, y el pedido va a bodega', async () => {
    const { svc, tx, transicion, reposicion } = crearServicio([item({ id: 1 }), sinExistencia()]);

    const r = await svc.ajustar(1, usuario, 'Ya llegó la talla', [
      { tipo: 'reponer', itemId: 2, cantidad: 3 } as never,
    ]);

    const upd = dataDe(tx, 2);
    expect(upd).toMatchObject({
      cancelada: false,
      cantidad: 3,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 0,
      piezasRetiradas: 0,
    });
    // `cantidadPedida` es lo que el cliente pidió: no se escribe.
    expect(upd).not.toHaveProperty('cantidadPedida');
    expect(Number(upd.subtotal)).toBe(300);

    // Nadie ha visto esas piezas en el anaquel: bodega las verifica.
    expect(transicion.dto.nuevoEstado).toBe(EstadoPedido.EN_REVISION);
    expect(r.vaABodega).toBe(true);
    // Reponer no saca nada de la bolsa.
    expect(reposicion.registrarQuitadasEnMostrador).not.toHaveBeenCalled();
  });

  it('una línea que alguien QUITÓ teniendo piezas apartadas no se puede reponer', async () => {
    const { svc } = crearServicio([
      item({ id: 1 }),
      sinExistencia({ cantidadSurtida: 4, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    await expect(
      svc.ajustar(1, usuario, 'Quiere el 2', [
        { tipo: 'reponer', itemId: 2, cantidad: 3 } as never,
      ]),
    ).rejects.toThrow(/no se puede reponer/);
  });

  it('una línea viva no se repone: para eso es `parcial`', async () => {
    const { svc } = crearServicio([item({ id: 1 }), sinExistencia()]);

    await expect(
      svc.ajustar(1, usuario, 'Quiere más', [{ tipo: 'reponer', itemId: 1, cantidad: 3 } as never]),
    ).rejects.toThrow(/no se puede reponer/);
  });

  it('exige una cantidad mayor a 0', async () => {
    const { svc } = crearServicio([item({ id: 1 }), sinExistencia()]);

    await expect(
      svc.ajustar(1, usuario, 'x', [{ tipo: 'reponer', itemId: 2 } as never]),
    ).rejects.toThrow(/cantidad mayor a 0/);
  });
});
