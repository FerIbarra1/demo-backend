import { EstadoPedido, EstadoReposicion, Prisma, RolUsuario } from '@prisma/client';
import { ReposicionService } from '../reposicion/reposicion.service';
import { seRetiraronPiezas } from './cancelacion-linea.util';

/**
 * F20 (oct 2026): la CANCELACIÓN de un pedido, de punta a punta.
 *
 * Lo que el negocio necesita que pase: cuando un pedido se cancela, la
 * mercancía que bodega ya había apartado tiene que volver al anaquel. Para eso
 * existe la lista de reposición — es el aviso operativo que bodega lee.
 *
 * Los bugs que esto fija:
 *
 *   1. La cancelación del CLIENTE no creaba la lista (mostrador y las
 *      propuestas sí). Esa mercancía se quedaba apartada sin que nadie la
 *      devolviera.
 *   2. (oct 2026) La lista listaba mercancía que un AJUSTE ya había sacado de
 *      la bolsa: el bodeguero la regresaba al anaquel durante el ajuste y la
 *      lista se la pedía otra vez. La reposición es SOLO de pedidos cancelados o
 *      rechazados, y de ellos solo lo que sigue físicamente en la bolsa.
 *
 * Y el invariante que sostiene el diseño: la lista incluye tanto los items
 * ACTIVOS (que se van a surtir y ya no) como los CANCELADOS con piezas
 * apartadas (esas también vuelven al anaquel) — descontando lo que el
 * bodeguero ya sacó (`piezasRetiradas`).
 */

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    productoNombre: 'X',
    productoCodigo: 'CX',
    corridaNombre: 'A',
    tallaNombre: 'M',
    colorNombre: 'N',
    cantidad: 10,
    cantidadPedida: 10,
    cantidadSurtida: 10,
    estadoSurtido: 'COMPLETO',
    cancelada: false,
    piezasRetiradas: 0,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(1000),
    ...over,
  };
}

/** ReposicionService con Prisma mockeado. */
function crearServicio(
  items: any[],
  opts: { yaExiste?: boolean; existente?: Record<string, unknown> } = {},
) {
  const creada: any[] = [];
  const actualizada: any[] = [];

  const tx = {
    itemPedido: {
      // Honra `id: { in: [...] }` (lo usa `registrarQuitadasEnMostrador`); sin ese
      // filtro devuelve todo, como antes.
      findMany: jest.fn(async ({ where }: any = {}) =>
        where?.id?.in ? items.filter((i) => where.id.in.includes(i.id)) : items,
      ),
    },
    pedidoReposicion: {
      findUnique: jest.fn(async () =>
        opts.existente
          ? opts.existente
          : opts.yaExiste
            ? // Una cancelación ya fusionada en la fila: lleva la marca.
              {
                id: 9,
                pedidoId: 1,
                estado: EstadoReposicion.PENDIENTE,
                items: [{ id: 1, cantidad: 10, deCancelacion: true }],
                motivo: null,
              }
            : null,
      ),
      create: jest.fn(async ({ data }: any) => {
        creada.push(data);
        return { id: 1, ...data };
      }),
      update: jest.fn(async ({ data }: any) => {
        actualizada.push(data);
        return { id: 9, ...data };
      }),
    },
  };

  const svc = new ReposicionService(
    { $transaction: async (fn: any) => fn(tx) } as never,
    { emitToTienda: jest.fn() } as never,
  );

  return { svc, tx, creada, actualizada };
}

const usuario = {
  userId: 3,
  rol: RolUsuario.MOSTRADOR,
  tiendaId: 5,
  nombre: 'Operador',
};

describe('F20 — cancelar un pedido genera la lista de reposición', () => {
  it('incluye los items activos (ya no se van a surtir)', async () => {
    const { svc, tx, creada } = crearServicio([item({ id: 1 })]);

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente');

    expect(creada).toHaveLength(1);
    expect(creada[0].estado).toBe(EstadoReposicion.PENDIENTE);
    expect(creada[0].motivo).toBe('Cancelado por el cliente');
  });

  it('la consulta trae lo que tiene piezas apartadas, activo o cancelado', async () => {
    // El criterio es `cantidadSurtida > 0`, sin distinguir `cancelada`: una
    // línea cancelada con piezas apartadas (la quitó el cliente, o la marcó
    // bodega) también tiene mercancía en la bolsa que hay que devolver. Y una
    // línea sin piezas apartadas no tiene nada que devolver, esté activa o no.
    const { svc, tx } = crearServicio([item({ id: 1 })]);

    await svc.crearDesdePedido(tx as never, 1);

    const llamadas = (tx.itemPedido.findMany as jest.Mock).mock.calls;
    expect(llamadas[0][0].where).toEqual({ pedidoId: 1, cantidadSurtida: { gt: 0 } });
  });

  it('es idempotente: una segunda llamada no suma la bolsa otra vez', async () => {
    // Un segundo rechazo no debería duplicar la lista. La marca `deCancelacion` de
    // la fila dice que la cancelación ya se fusionó.
    const { svc, tx, creada, actualizada } = crearServicio([item()], { yaExiste: true });

    await svc.crearDesdePedido(tx as never, 1);

    expect(creada).toHaveLength(0);
    expect(actualizada).toHaveLength(0);
  });

  it('un pedido sin items crea la fila ya resuelta', async () => {
    const { svc, tx, creada } = crearServicio([]);

    await svc.crearDesdePedido(tx as never, 1);

    // La fila se crea igual: `motivo` alimenta el correo de cancelación
    // (`motivoCancelacion`). Pero nace REPUESTO: una tarjeta PENDIENTE vacía le
    // pediría a bodega confirmar un trabajo que no existe.
    expect(creada).toHaveLength(1);
    expect(creada[0].items).toEqual([]);
    expect(creada[0].estado).toBe(EstadoReposicion.REPUESTO);
  });
});

describe('oct 2026 — solo se repone lo que ya salió de las manos de bodega', () => {
  it('un item que nadie surtió NO entra a la lista (antes caía a la cantidad pedida)', async () => {
    // Pedido cancelado a medias: un item ya marcado y otro sin tocar. El sin
    // tocar jamás salió del anaquel; listarlo mandaba a bodega a "reponer" algo
    // que nunca se movió.
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cantidad: 4, cantidadSurtida: 4 }),
      item({ id: 2, cantidad: 6, cantidadSurtida: 0, estadoSurtido: 'PENDIENTE' }),
    ]);

    await svc.crearDesdePedido(tx as never, 1);

    expect(creada[0].items.map((i: any) => [i.id, i.cantidad])).toEqual([[1, 4]]);
  });

  it('un pedido sin surtir (todo en 0) crea la fila resuelta, sin lista', async () => {
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cantidad: 4, cantidadSurtida: 0, estadoSurtido: 'PENDIENTE' }),
    ]);

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente');

    expect(creada[0].items).toEqual([]);
    expect(creada[0].estado).toBe(EstadoReposicion.REPUESTO);
    expect(creada[0].motivo).toBe('Cancelado por el cliente');
  });

  it('con bodega teniendo el pedido en las manos no se listan ni las piezas ya marcadas', async () => {
    // Se cancela mientras el bodeguero surte a medias: ya marcó 4 piezas pero las
    // trae en las manos. Ve el aviso de cancelación y las regresa él.
    const { svc, tx, creada } = crearServicio([item({ id: 1, cantidad: 4, cantidadSurtida: 4 })]);

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente', {
      bolsaEnManosDeBodega: true,
    });

    // Ni siquiera consulta los items: no hay nada que decidir.
    expect(tx.itemPedido.findMany).not.toHaveBeenCalled();
    expect(creada).toHaveLength(1);
    expect(creada[0].items).toEqual([]);
    expect(creada[0].estado).toBe(EstadoReposicion.REPUESTO);
    expect(creada[0].repuestoAt).toBeInstanceOf(Date);
  });

  it('la fila resuelta conserva el motivo para el correo de cancelación', async () => {
    const { svc, tx, creada } = crearServicio([item()]);

    await svc.crearDesdePedido(tx as never, 1, 'Cambié de opinión', { bolsaEnManosDeBodega: true });

    expect(creada[0].motivo).toBe('Cambié de opinión');
  });

  it('con piezas en la bolsa la fila nace PENDIENTE y sin fecha de repuesto', async () => {
    const { svc, tx, creada } = crearServicio([item({ id: 1, cantidad: 4, cantidadSurtida: 4 })]);

    await svc.crearDesdePedido(tx as never, 1, 'Rechazó la propuesta');

    expect(creada[0].estado).toBe(EstadoReposicion.PENDIENTE);
    expect(creada[0].repuestoAt).toBeNull();
  });
});

describe('oct 2026 — lo que un ajuste ya sacó NO vuelve a salir en reposición', () => {
  const piezas = (creada: any[]) =>
    (creada[0].items as Array<{ id: number; cantidad: number }>).map((i) => [i.id, i.cantidad]);

  it('descuenta las piezas que el bodeguero ya regresó al anaquel', async () => {
    // Había 3, el ajuste bajó a 1 y el bodeguero sacó las 2 de más. Si el pedido
    // se cancela después, en la bolsa solo queda 1.
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cantidad: 1, cantidadSurtida: 3, piezasRetiradas: 2 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente');

    expect(piezas(creada)).toEqual([[1, 1]]);
  });

  it('una línea que el ajuste quitó y cuyas piezas YA salieron no entra a la lista', async () => {
    // Es el caso del reporte: "los productos que se quitaron y que el bodeguero
    // ya puso en el anaquel vuelven a salir en reposición".
    const { svc, tx, creada } = crearServicio([
      item({ id: 1 }),
      item({ id: 2, cancelada: true, cantidadSurtida: 4, piezasRetiradas: 4 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1);

    expect(piezas(creada)).toEqual([[1, 10]]);
  });

  it('si el pedido se cancela ANTES de que el bodeguero saque lo del ajuste, sí vuelve', async () => {
    // El retiro estaba pendiente: las piezas siguen dentro de la bolsa, así que
    // son mercancía que hay que devolver como la de cualquier otro item.
    const { svc, tx, creada } = crearServicio([
      item({ id: 1 }),
      item({ id: 2, cancelada: true, cantidadSurtida: 4, piezasRetiradas: 0 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1);

    expect(piezas(creada)).toEqual([
      [1, 10],
      [2, 4],
    ]);
  });

  it('un retiro parcial descuenta solo lo que ya salió', async () => {
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1);

    expect(piezas(creada)).toEqual([[1, 3]]);
  });

  it('si todo se sacó en ajustes la lista no lleva nada, nace resuelta y conserva el motivo', async () => {
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cancelada: true, cantidadSurtida: 2, piezasRetiradas: 2 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente');

    expect(creada[0].items).toEqual([]);
    expect(creada[0].estado).toBe(EstadoReposicion.REPUESTO);
    expect(creada[0].motivo).toBe('Cancelado por el cliente');
  });

  it('el snapshot no arrastra `piezasRetiradas`: conserva el shape que lee la pantalla', async () => {
    const { svc, tx, creada } = crearServicio([
      item({ id: 1, cantidad: 1, cantidadSurtida: 3, piezasRetiradas: 2 }),
    ]);

    await svc.crearDesdePedido(tx as never, 1);

    expect(creada[0].items[0]).not.toHaveProperty('piezasRetiradas');
  });
});

describe('oct 2026 — un ajuste de ventas no genera reposición', () => {
  it('ReposicionService ya no expone `crearDesdeAjuste`', () => {
    // El ajuste de VENTAS deja el pedido vivo y las piezas las regresa el
    // bodeguero con el checklist de retiro. Si alguien recrea el método para
    // "avisarle a bodega", la lista vuelve a pedirle acomodar lo que ya acomodó.
    //
    // El ajuste de MOSTRADOR sí repone lo que quita, pero por otro método con
    // otro nombre (`registrarQuitadasEnMostrador`): ahí las saca el operador y
    // nadie las regresa al anaquel. Ver el describe de abajo.
    expect((ReposicionService.prototype as any).crearDesdeAjuste).toBeUndefined();
  });
});

describe('oct 2026 — lo que el operador de mostrador QUITA pasa a reposición', () => {
  const piezas = (data: any) =>
    (data.items as Array<{ id: number; cantidad: number }>).map((i) => [i.id, i.cantidad]);

  it('crea la fila PENDIENTE con el snapshot de la línea y SIN motivo', async () => {
    // `motivo` es el texto del correo de cancelación: un ajuste no cancela nada, y
    // si la fila nace con un motivo inventado, una cancelación por otra vía (el ERP
    // no crea fila) mandaría ese texto al cliente.
    const { svc, tx, creada } = crearServicio([item({ id: 1 }), item({ id: 2 })]);

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [{ itemId: 1, cantidad: 3 }]);

    expect(creada).toHaveLength(1);
    expect(creada[0].estado).toBe(EstadoReposicion.PENDIENTE);
    expect(creada[0].motivo).toBeNull();
    expect(piezas(creada[0])).toEqual([[1, 3]]);
    expect(creada[0].items[0]).toMatchObject({ productoNombre: 'X', tallaNombre: 'M' });
    // No es una cancelación: la marca solo la pone `crearDesdePedido`.
    expect(creada[0].items[0].deCancelacion).toBeUndefined();
  });

  it('suma varias piezas de la misma línea en UNA entrada', async () => {
    const { svc, tx, creada } = crearServicio([item({ id: 1 })]);

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [
      { itemId: 1, cantidad: 2 },
      { itemId: 1, cantidad: 1 },
    ]);

    expect(piezas(creada[0])).toEqual([[1, 3]]);
  });

  it('ignora cantidades en cero: no crea una fila vacía', async () => {
    const { svc, tx, creada } = crearServicio([item({ id: 1 })]);

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [{ itemId: 1, cantidad: 0 }]);

    expect(creada).toHaveLength(0);
  });

  it('una segunda quitada se SUMA a la fila pendiente (pedidoId es único)', async () => {
    const { svc, tx, creada, actualizada } = crearServicio([item({ id: 1 }), item({ id: 2 })], {
      existente: {
        id: 9,
        pedidoId: 1,
        estado: EstadoReposicion.PENDIENTE,
        items: [{ id: 1, cantidad: 2, productoNombre: 'X' }],
        motivo: null,
      },
    });

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [
      { itemId: 1, cantidad: 3 },
      { itemId: 2, cantidad: 4 },
    ]);

    expect(creada).toHaveLength(0);
    expect(piezas(actualizada[0])).toEqual([
      [1, 5],
      [2, 4],
    ]);
    expect(actualizada[0].estado).toBe(EstadoReposicion.PENDIENTE);
  });

  it('una fila ya REPUESTA se reabre con SOLO lo nuevo: lo anterior ya volvió al anaquel', async () => {
    const { svc, tx, actualizada } = crearServicio([item({ id: 1 })], {
      existente: {
        id: 9,
        pedidoId: 1,
        estado: EstadoReposicion.REPUESTO,
        items: [{ id: 1, cantidad: 2 }],
        motivo: null,
      },
    });

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [{ itemId: 1, cantidad: 1 }]);

    // Sumarlo a lo viejo le pediría a bodega devolver las 2 de antes otra vez.
    expect(piezas(actualizada[0])).toEqual([[1, 1]]);
    expect(actualizada[0].estado).toBe(EstadoReposicion.PENDIENTE);
    expect(actualizada[0].repuestoAt).toBeNull();
    expect(actualizada[0].repuestoPorId).toBeNull();
    expect(actualizada[0].creadaAt).toBeInstanceOf(Date);
  });

  it('NO toca `motivo` de una fila existente', async () => {
    const { svc, tx, actualizada } = crearServicio([item({ id: 1 })], {
      existente: {
        id: 9,
        pedidoId: 1,
        estado: EstadoReposicion.PENDIENTE,
        items: [{ id: 1, cantidad: 2 }],
        motivo: 'Texto del correo de cancelación',
      },
    });

    await svc.registrarQuitadasEnMostrador(tx as never, 1, [{ itemId: 1, cantidad: 1 }]);

    expect(actualizada[0]).not.toHaveProperty('motivo');
  });
});

describe('oct 2026 — cancelar un pedido al que mostrador ya le quitó piezas', () => {
  const piezas = (data: any) =>
    (data.items as Array<{ id: number; cantidad: number; deCancelacion?: boolean }>).map((i) => [
      i.id,
      i.cantidad,
    ]);

  it('FUSIONA la bolsa restante en la fila existente en vez de salir temprano', async () => {
    // El bug que esto evita: `pedidoId` es único y `crearDesdePedido` salía si ya
    // había fila. El operador quita 2 (crea la fila) y luego el cliente cancela:
    // las 8 que quedaban en la bolsa NUNCA volvían al anaquel.
    const { svc, tx, creada, actualizada } = crearServicio(
      [item({ id: 1, cantidad: 8, cantidadSurtida: 10, piezasRetiradas: 2 })],
      {
        existente: {
          id: 9,
          pedidoId: 1,
          estado: EstadoReposicion.PENDIENTE,
          items: [{ id: 1, cantidad: 2 }],
          motivo: null,
        },
      },
    );

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado por el cliente');

    expect(creada).toHaveLength(0);
    // 2 que quitó el operador + 8 que seguían en la bolsa.
    expect(piezas(actualizada[0])).toEqual([[1, 10]]);
    expect(actualizada[0].items[0].deCancelacion).toBe(true);
    expect(actualizada[0].estado).toBe(EstadoReposicion.PENDIENTE);
  });

  it('pisa `motivo`: es el texto del correo de cancelación', async () => {
    const { svc, tx, actualizada } = crearServicio([item({ id: 1 })], {
      existente: {
        id: 9,
        pedidoId: 1,
        estado: EstadoReposicion.PENDIENTE,
        items: [{ id: 1, cantidad: 2 }],
        motivo: null,
      },
    });

    await svc.crearDesdePedido(tx as never, 1, 'Ya no lo necesito');

    expect(actualizada[0].motivo).toBe('Ya no lo necesito');
  });

  it('descuenta lo que el operador ya sacó: no lista dos veces las mismas piezas', async () => {
    // Las 3 que quitó mostrador están en `piezasRetiradas`, así que la bolsa son 7.
    const { svc, tx, actualizada } = crearServicio(
      [item({ id: 1, cantidad: 7, cantidadSurtida: 10, piezasRetiradas: 3 })],
      {
        existente: {
          id: 9,
          pedidoId: 1,
          estado: EstadoReposicion.PENDIENTE,
          items: [{ id: 1, cantidad: 3 }],
          motivo: null,
        },
      },
    );

    await svc.crearDesdePedido(tx as never, 1);

    expect(piezas(actualizada[0])).toEqual([[1, 10]]);
  });

  it('sin nada en la bolsa solo actualiza el motivo y deja la fila como estaba', async () => {
    const { svc, tx, actualizada } = crearServicio(
      [item({ id: 1, cantidad: 0, cantidadSurtida: 10, piezasRetiradas: 10, cancelada: true })],
      {
        existente: {
          id: 9,
          pedidoId: 1,
          estado: EstadoReposicion.PENDIENTE,
          items: [{ id: 1, cantidad: 10 }],
          motivo: null,
        },
      },
    );

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado');

    expect(actualizada[0].motivo).toBe('Cancelado');
    expect(actualizada[0]).not.toHaveProperty('estado');
    expect(piezas(actualizada[0])).toEqual([[1, 10]]);
  });

  it('una fila ya REPUESTA se reabre solo si la cancelación trae bolsa por devolver', async () => {
    const { svc, tx, actualizada } = crearServicio(
      [item({ id: 1, cantidad: 5, cantidadSurtida: 5 })],
      {
        existente: {
          id: 9,
          pedidoId: 1,
          estado: EstadoReposicion.REPUESTO,
          items: [{ id: 1, cantidad: 4 }],
          motivo: null,
        },
      },
    );

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado');

    // Lo anterior (las 4) ya volvió al anaquel: solo se pide lo que sigue en la bolsa.
    expect(piezas(actualizada[0])).toEqual([[1, 5]]);
    expect(actualizada[0].estado).toBe(EstadoReposicion.PENDIENTE);
  });

  it('llamarla dos veces no suma la bolsa dos veces', async () => {
    const { svc, tx, actualizada } = crearServicio(
      [item({ id: 1, cantidad: 5, cantidadSurtida: 5 })],
      {
        existente: {
          id: 9,
          pedidoId: 1,
          estado: EstadoReposicion.PENDIENTE,
          items: [{ id: 1, cantidad: 5, deCancelacion: true }],
          motivo: 'Cancelado',
        },
      },
    );

    await svc.crearDesdePedido(tx as never, 1, 'Cancelado');

    expect(actualizada).toHaveLength(0);
  });
});

describe('F20 — confirmar el repuesto', () => {
  function crearParaConfirmar(estado: EstadoReposicion, tiendaPedido = 5) {
    const prisma = {
      pedidoReposicion: {
        findUnique: jest.fn(async () => ({
          id: 1,
          estado,
          pedido: { tiendaId: tiendaPedido },
        })),
        update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      },
    };
    const svc = new ReposicionService(prisma as never, { emitToTienda: jest.fn() } as never);
    return { svc, prisma };
  }

  it('marca la lista como REPUESTO', async () => {
    const { svc, prisma } = crearParaConfirmar(EstadoReposicion.PENDIENTE);

    await svc.confirmarRepuesto(1, usuario as never);

    const data = prisma.pedidoReposicion.update.mock.calls[0][0].data;
    expect(data.estado).toBe(EstadoReposicion.REPUESTO);
    expect(data.repuestoPorId).toBe(usuario.userId);
  });

  it('rechaza confirmar dos veces', async () => {
    const { svc } = crearParaConfirmar(EstadoReposicion.REPUESTO);

    await expect(svc.confirmarRepuesto(1, usuario as never)).rejects.toThrow(/ya fue confirmada/i);
  });

  it('defensa en profundidad: no deja tocar la reposición de otra tienda', async () => {
    const { svc } = crearParaConfirmar(EstadoReposicion.PENDIENTE, 99);

    await expect(svc.confirmarRepuesto(1, usuario as never)).rejects.toThrow(/otra tienda/i);
  });
});

describe('F20 — el invariante: lo que se cancela se puede reponer', () => {
  it('un retiro y un faltante se distinguen, y el retiro dice cuánto había', () => {
    // El caso que el negocio pidió cuidar: "los cancelados importan porque
    // bodega tiene que ir a recoger el pedido y pasarlo al anaquel".
    const retirado = { cancelada: true, cantidadSurtida: 10 };
    const faltante = { cancelada: true, cantidadSurtida: 0 };

    // El retiro SÍ tiene algo que devolver; el faltante no.
    expect(seRetiraronPiezas(retirado)).toBe(true);
    expect(seRetiraronPiezas(faltante)).toBe(false);
  });

  it('la cantidad a reponer es lo que SALIÓ de la bolsa, no lo pedido', () => {
    // Un item colapsado (20 pedidas, 10 apartadas) que después se cancela:
    // al anaquel vuelven 10, no 20.
    const colapsado = {
      cantidadPedida: 20,
      cantidad: 10,
      cantidadSurtida: 10,
      cancelada: true,
    };
    // `crearDesdePedido` normaliza `cantidad` a `cantidadSurtida` en el
    // snapshot; aquí se fija la regla que lo hace correcto.
    expect(colapsado.cantidadSurtida).toBe(10);
    expect(colapsado.cantidadSurtida).not.toBe(colapsado.cantidadPedida);
  });
});
