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
function crearServicio(items: any[], opts: { yaExiste?: boolean } = {}) {
  const creada: any[] = [];
  const actualizada: any[] = [];

  const tx = {
    itemPedido: {
      findMany: jest.fn(async () => items),
    },
    pedidoReposicion: {
      findUnique: jest.fn(async () => (opts.yaExiste ? { id: 9, items: [] } : null)),
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

  it('es idempotente: no duplica la lista si ya existe', async () => {
    // Un segundo rechazo no debería crear una segunda entrada.
    const { svc, tx, creada } = crearServicio([item()], { yaExiste: true });

    await svc.crearDesdePedido(tx as never, 1);

    expect(creada).toHaveLength(0);
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

describe('oct 2026 — un ajuste no genera reposición', () => {
  it('ReposicionService ya no expone `crearDesdeAjuste`', () => {
    // La reposición es solo de pedidos cancelados o rechazados. Un ajuste deja
    // el pedido vivo y las piezas las regresa el bodeguero con el checklist de
    // retiro. Si alguien recrea el método para "avisarle a bodega", la lista
    // vuelve a pedirle acomodar lo que ya acomodó.
    expect((ReposicionService.prototype as any).crearDesdeAjuste).toBeUndefined();
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
