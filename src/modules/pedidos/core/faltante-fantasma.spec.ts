import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  EstadoPedido,
  EstadoSurtido,
  ModoEntrega,
  Prisma,
  RolUsuario,
} from '@prisma/client';
import { SurtidoService } from '../bodega/surtido.service';
import { PropuestaService } from '../propuesta/propuesta.service';

/**
 * F16 (sep 2026): el bug del "faltante fantasma".
 *
 * Escenario real reportado: bodega marca un item incompleto → el cliente pide
 * asesor → el asesor propone (cambiando ese item y agregando otros) → el
 * cliente aprueba → el pedido vuelve a bodega → el bodeguero surte tal cual lo
 * aprobado y recibe:
 *
 *   400 "Hay 1 item(s) con faltante. Envía la propuesta al cliente..."
 *
 * El bodeguero no tenía nada que corregir. El "1 con faltante" era el item
 * ORIGINAL que el asesor reemplazó: al cancelarlo, `aplicarPropuestaDeVentas`
 * escribía `cancelada: true` sin limpiar `estadoSurtido`, y el filtro de
 * `confirmarSurtido` no excluía cancelados. Ese item ya liquidado exigía una
 * propuesta ACEPTADA sin consumir — y como TODA aprobación marca `consumidaAt`
 * en el mismo acto, la rama era inalcanzable y el 400 inevitable.
 *
 * Estos tests fijan las dos mitades del arreglo: el filtro de cancelados y la
 * coherencia del estado al aplicar la propuesta.
 */

const usuario = {
  userId: 42,
  rol: RolUsuario.BODEGA,
  tiendaId: 5,
  nombre: 'Bodeguero',
};

/**
 * `SurtidoService` con Prisma mockeado. `items` es el pedido tal como lo lee
 * `confirmarSurtido`; `cambiarEstado` se registra para poder afirmar el destino.
 */
function crearSurtido(items: any[], opts: { propuestaAceptada?: boolean } = {}) {
  const transiciones: Array<{ nuevoEstado: EstadoPedido; observacion?: string }> = [];

  const prisma = {
    pedido: {
      findUnique: jest.fn(async () => ({
        id: 1,
        estado: EstadoPedido.REVIEWING,
        tiendaId: 5,
        asignadoAId: usuario.userId,
        modoEntrega: ModoEntrega.KIOSKO,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
        items,
      })),
    },
    pedidoPropuesta: {
      findFirst: jest.fn(async () =>
        opts.propuestaAceptada ? { id: 77 } : null,
      ),
      update: jest.fn(async () => ({})),
    },
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => {
        const it = items.find((i) => i.id === where.id);
        return it ? { ...it, precioUnitario: new Prisma.Decimal(100) } : null;
      }),
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
    },
    pedidoReposicion: { create: jest.fn(async () => ({})) },
  };

  const state = {
    cambiarEstado: jest.fn(async (_id: number, dto: any, _u: any, o: any) => {
      transiciones.push({
        nuevoEstado: dto.nuevoEstado,
        observacion: dto.observacion,
      });
      if (o?.efectos) await o.efectos(prisma);
      return { id: 1, estado: dto.nuevoEstado };
    }),
  };

  const svc = new SurtidoService(
    prisma as never,
    { cargarYValidar: jest.fn(async () => ({ id: 1 })) } as never,
    state as never,
    { enviar: jest.fn() } as never,
    { emitToPedido: jest.fn(), emitToTienda: jest.fn() } as never,
    { resolverImagen: jest.fn((u: any) => u) } as never,
  );

  return { svc, prisma, transiciones };
}

/** Un item base del pedido. */
function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 5,
    cantidadSurtida: 5,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(500),
    ...over,
  };
}

describe('confirmarSurtido: los items cancelados no son faltantes', () => {
  it('un item cancelado con NO_DISPONIBLE NO bloquea la confirmación', async () => {
    // El caso exacto del reporte: el asesor reemplazó el item, quedó cancelado
    // con su `estadoSurtido` sucio, y el bodeguero surtió todo lo demás bien.
    const { svc, transiciones } = crearSurtido([
      item({ id: 1, cancelada: true, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
      item({ id: 2 }), // el producto nuevo que el asesor agregó, surtido completo
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
    expect(transiciones[0].nuevoEstado).toBe(EstadoPedido.EN_MOSTRADOR);
  });

  it('un item cancelado con PARCIAL NO bloquea la confirmación', async () => {
    const { svc } = crearSurtido([
      item({ id: 1, cancelada: true, estadoSurtido: EstadoSurtido.PARCIAL, cantidadSurtida: 2 }),
      item({ id: 2 }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
  });

  it('un item cancelado PENDIENTE no exige marcarlo', async () => {
    // Sin el filtro, un item cancelado sin marcar bloqueaba con "aún PENDIENTE
    // de surtir" — imposible de resolver, porque ya no está en la lista.
    const { svc } = crearSurtido([
      item({ id: 1, cancelada: true, estadoSurtido: EstadoSurtido.PENDIENTE, cantidadSurtida: 0 }),
      item({ id: 2 }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
  });

  it('un faltante GENUINO (no cancelado) sí sigue pidiendo propuesta', async () => {
    // La regla de negocio: bodega surtió menos de lo aprobado → nueva
    // aprobación del cliente. Este es el caso legítimo del 400.
    const { svc } = crearSurtido([
      item({ id: 1, estadoSurtido: EstadoSurtido.PARCIAL, cantidadSurtida: 1 }),
      item({ id: 2 }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('un item cancelado COMPLETO no cuenta como producto activo', async () => {
    // El guard de "pedido sin productos": si el único item vivo se cancela, el
    // pedido no puede avanzar a pago aunque el cancelado se viera "completo".
    const { svc } = crearSurtido([
      item({ id: 1, cancelada: true, estadoSurtido: EstadoSurtido.COMPLETO }),
      item({ id: 2, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).rejects.toThrow(
      /todos los productos quedarían cancelados/i,
    );
  });

  it('un item cancelado COMPLETO con menos piezas no dispara el guard de incoherencia', async () => {
    const { svc } = crearSurtido([
      item({ id: 1, cancelada: true, estadoSurtido: EstadoSurtido.COMPLETO, cantidad: 5, cantidadSurtida: 2 }),
      item({ id: 2 }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
  });
});

// ============================================================================

/**
 * `PropuestaService.aplicarPropuestaDeVentas` con Prisma mockeado. Se prueba el
 * estado final de los items, que es lo que sostiene "lo que se cobra es lo que
 * se surtió".
 */
function crearPropuesta(items: any[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const creates: any[] = [];

  const tx = {
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => {
        const it = items.find((i) => i.id === where.id);
        return it ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      }),
      create: jest.fn(async ({ data }: any) => {
        creates.push(data);
        return {};
      }),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
      // El guard de "pedido sin productos" (H3) cuenta items no cancelados.
      // Si el test arma todos los items cancelados, este guard va a
      // atraparlo — los tests de `'completo' sobre COMPLETO` y
      // `NINGÚN camino deja COMPLETO con menos piezas` no quieren ese
      // guard, así que devolvemos el conteo real.
      count: jest.fn(async ({ where }: any) => {
        const cancelada = (where as { cancelada?: boolean })?.cancelada;
        return items.filter((i) => (cancelada === undefined ? true : i.cancelada === cancelada)).length;
      }),
    },
    precioCO: {
      findUnique: jest.fn(async () => ({
        id: 900,
        productoId: 7,
        tiendaId: 5,
        precio: new Prisma.Decimal(100),
        producto: { nombre: 'Camisa Y', codigo: 'CY-1' },
        talla: { nombre: 'M' },
        color: { nombre: 'Azul' },
        corrida: { nombre: 'Unica' },
      })),
    },
    pedido: { update: jest.fn(async () => ({})) },
  };

  const svc = new PropuestaService(
    { pedidoPropuesta: { update: jest.fn() } } as never,
    { emitToPedido: jest.fn(), emitToTienda: jest.fn() } as never,
    { cargarYValidar: jest.fn() } as never,
    { cambiarEstado: jest.fn() } as never,
    { crearDesdePedido: jest.fn() } as never,
    { columnaParaPedido: jest.fn(async () => 'precio1') } as never,
  );

  const aplicar = (svc as any).aplicarPropuestaDeVentas.bind(svc);
  const pedido = {
    id: 1,
    tiendaId: 5,
    descuento: new Prisma.Decimal(0),
    impuestos: new Prisma.Decimal(0),
  };

  return { aplicar, tx, pedido, updates, creates };
}

describe('aplicarPropuestaDeVentas: el item liquidado queda coherente', () => {
  it("'cambio' limpia el estado de surtido del item original", async () => {
    // La causa raíz del faltante fantasma.
    const { aplicar, tx, pedido, updates } = crearPropuesta([
      item({ id: 1, estadoSurtido: EstadoSurtido.PARCIAL, cantidadSurtida: 2 }),
    ]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'cambio',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
          cantidadNueva: 3,
          precioCOId: 900,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    const original = updates.find((u) => u.id === 1);
    expect(original?.data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
  });

  it("'parcial' que SUBE la cantidad devuelve el item a bodega", async () => {
    // Bodega tiene 3, el asesor propone 5: nadie verificó esas 2 piezas.
    const { aplicar, tx, pedido, updates } = crearPropuesta([
      item({ id: 1, cantidad: 5, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL }),
    ]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
          cantidadNueva: 5,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    expect(updates[0].data).toMatchObject({
      cantidad: 5,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 0,
    });
  });

  it("'parcial' que BAJA la cantidad deja el item COMPLETO", async () => {
    const { aplicar, tx, pedido, updates } = crearPropuesta([
      item({ id: 1, cantidad: 5, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL }),
    ]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
          cantidadNueva: 2,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    expect(updates[0].data).toMatchObject({
      cantidad: 2,
      estadoSurtido: EstadoSurtido.COMPLETO,
      cantidadSurtida: 2,
    });
  });

  it("'completo' sobre un item PARCIAL lo liquida a lo que hay", async () => {
    // El asesor no lo tocó: el cliente aprobó lo que bodega encontró. Sin esto
    // el item quedaba en faltante y la confirmación daba 400.
    const { aplicar, tx, pedido, updates } = crearPropuesta([
      item({ id: 1, cantidad: 5, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL }),
    ]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'completo',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    expect(updates[0].data).toMatchObject({
      cantidad: 3,
      estadoSurtido: EstadoSurtido.COMPLETO,
    });
  });

  it("'completo' sobre un item NO_DISPONIBLE lo cancela", async () => {
    const { aplicar, tx, pedido, updates } = crearPropuesta([
      item({ id: 1, cantidad: 5, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE }),
    ]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'completo',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    expect(updates[0].data).toMatchObject({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
  });

  it("'completo' sobre un item COMPLETO no toca nada", async () => {
    const { aplicar, tx, pedido, updates } = crearPropuesta([item({ id: 1 })]);

    await aplicar(
      tx,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'completo',
          producto: 'Camisa X',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
        },
      ],
      [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
      'precio1',
    );

    expect(updates).toHaveLength(0);
  });

  it('NINGÚN camino deja COMPLETO con menos piezas que las pedidas', async () => {
    // El invariante que sostiene "lo que se cobra es lo que se surtió". Si se
    // rompe, el pedido avanza a pago cobrando piezas que nadie apartó.
    for (const cantidadNueva of [1, 2, 3, 5, 10]) {
      for (const cantidadSurtida of [0, 1, 2, 3]) {
        const { aplicar, tx, pedido, updates } = crearPropuesta([
          item({
            id: 1,
            cantidad: 5,
            cantidadSurtida,
            estadoSurtido:
              cantidadSurtida === 0
                ? EstadoSurtido.NO_DISPONIBLE
                : EstadoSurtido.PARCIAL,
          }),
        ]);

        await aplicar(
          tx,
          pedido,
          [
            {
              itemId: 1,
              tipo: 'parcial',
              producto: 'Camisa X',
              variante: 'M',
              cantidad: 5,
              precioUnitario: 100,
              subtotal: 500,
              cantidadNueva,
            },
          ],
          [{ id: 1, precioUnitario: new Prisma.Decimal(100) }],
          'precio1',
        );

        const u = updates[0];
        if (u && u.data.estadoSurtido === EstadoSurtido.COMPLETO) {
          expect(u.data.cantidadSurtida).toBe(u.data.cantidad);
        }
      }
    }
  });
});
