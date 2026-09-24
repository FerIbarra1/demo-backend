import {
  BadRequestException,
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
import { aplicarCambiosFisicos } from './aplicar-cambios-surtido.util';

/**
 * F16 (sep 2026): invariantes monetarios del flujo de propuestas + surtido.
 *
 * Después de cerrar el bug original del "faltante fantasma", una auditoría
 * adversarial encontró 8 problemas adicionales (H1–H8). Este spec cubre los
 * que se pueden probar en backend:
 *
 *   T1/T2 — H2 prevención: `enviarPropuesta` rechaza si bodega tiene
 *           items PENDIENTE.
 *   T3    — H2 red de seguridad: si por una carrera se cuela un item
 *           PENDIENTE en `aprobarPropuestaBodega`, el pedido vuelve a
 *           REVIEWING en vez de avanzar a pago.
 *   T4    — H3: `aplicarPropuestaDeVentas` rechaza dejar 0 items activos.
 *   T5/T6 — H4: una propuesta de ventas que omite un item PARCIAL/
 *           NO_DISPONIBLE residual hace que `quedanPendientes` sea
 *           `true` (el pedido vuelve a bodega).
 *   T7/T8 — H5: `marcarItem` rechaza `cantidadSurtida > cantidad` y
 *           rechaza items `cancelada`.
 *   T9    — H6: mostrador `no-disponible` deja `estadoSurtido:
 *           'NO_DISPONIBLE'` y `cantidadSurtida: 0`.
 *   T10   — H7: el helper compartido `aplicarCambiosFisicos` produce
 *           los mismos resultados que las copias que reemplaza.
 *
 * Las pruebas de frontend (H1) están en `demo-frontend` y se ejecutan
 * manualmente con el flujo E2E; Jest no está configurado ahí.
 */

const usuarioBodega = {
  userId: 42,
  rol: RolUsuario.BODEGA,
  tiendaId: 5,
  nombre: 'Bodeguero',
};

const usuarioVentas = {
  userId: 88,
  rol: RolUsuario.VENTAS,
  tiendaId: 5,
  nombre: 'Asesor',
};

const usuarioCliente = {
  userId: 100,
  rol: RolUsuario.CLIENTE,
  tiendaId: 5,
  nombre: 'Cliente',
};

/** Item base de pedido. */
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

// =============================================================================
// T1/T2 — H2: enviarPropuesta (BODEGA) debe rechazar items PENDIENTE
// =============================================================================

function crearPropuestaServiceParaEnvio(
  items: any[],
  opts: { pedidoEncontrado?: any } = {},
) {
  const creado: any[] = [];

  const pedido = opts.pedidoEncontrado ?? {
    id: 1,
    estado: EstadoPedido.REVIEWING,
    tiendaId: 5,
  };

  const prisma = {
    pedido: {
      findUnique: jest.fn(async () => pedido),
    },
    itemPedido: {
      findMany: jest.fn(async () => items),
    },
    pedidoPropuesta: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        creado.push(data);
        return { id: 99, ...data };
      }),
    },
  };

  const state = {
    // No usamos cambiarEstado en este test (la propuesta no transiciona
    // estado al enviar; eso pasa al aprobar).
    cambiarEstado: jest.fn(),
  };

  const realtime = {
    emitToUser: jest.fn(),
    emitToPedido: jest.fn(),
    emitToTienda: jest.fn(),
  };

  const access = { cargarYValidar: jest.fn() };
  const reposicion = { crearDesdePedido: jest.fn() };
  const precios = { columnaParaPedido: jest.fn() };

  const svc = new PropuestaService(
    prisma as never,
    realtime as never,
    access as never,
    state as never,
    reposicion as never,
    precios as never,
  );

  const enviar = svc.enviarPropuesta.bind(svc);
  return { svc, enviar, prisma, creado };
}

describe('T1/T2 — H2 prevención: enviarPropuesta valida items PENDIENTE', () => {
  it('lanza 400 si bodega tiene items PENDIENTE', async () => {
    const { enviar } = crearPropuestaServiceParaEnvio([
      item({ id: 1, estadoSurtido: EstadoSurtido.COMPLETO }),
      item({ id: 2, estadoSurtido: EstadoSurtido.PENDIENTE, cantidadSurtida: 0 }),
    ]);

    // El DTO necesita al menos 1 item (la validación previa de `length >
    // 0` está antes del guard de PENDIENTE), así que mandamos uno
    // cualquiera y dejamos el PENDIENTE en el pedido.
    await expect(
      enviar(
        1,
        {
          items: [
            {
              itemId: 1,
              tipo: 'completo',
              producto: '',
              variante: '',
              cantidad: 5,
              precioUnitario: 100,
              subtotal: 500,
            },
          ] as any,
          total: 500,
        },
        usuarioBodega,
      ),
    ).rejects.toThrow(/Hay 1 item\(s\) sin marcar/i);
  });

  it('acepta cuando todos los items están en estado terminal', async () => {
    const { enviar, creado } = crearPropuestaServiceParaEnvio([
      item({ id: 1, estadoSurtido: EstadoSurtido.COMPLETO }),
      item({ id: 2, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 }),
      item({ id: 3, estadoSurtido: EstadoSurtido.PARCIAL, cantidadSurtida: 2 }),
    ]);

    await enviar(
      1,
      {
        items: [
          { itemId: 1, tipo: 'completo', producto: '', variante: '', cantidad: 5, precioUnitario: 100, subtotal: 500 },
          { itemId: 2, tipo: 'no-disponible', producto: '', variante: '', cantidad: 5, precioUnitario: 100, subtotal: 500 },
          { itemId: 3, tipo: 'parcial', producto: '', variante: '', cantidad: 5, cantidadNueva: 2, precioUnitario: 100, subtotal: 500, subtotalNuevo: 200 },
        ] as any,
        total: 1200,
      },
      usuarioBodega,
    );

    expect(creado).toHaveLength(1);
    expect(creado[0].estado).toBe('PENDIENTE');
  });

  it('NO valida items PENDIENTE si el rol es VENTAS (su propio flujo)', async () => {
    // Ventas opera sobre pedidos en EN_ASESORIA/WAITING_CUSTOMER_APPROVAL;
    // el concepto de "PENDIENTE" es propio de bodega. Validar que la
    // guardia NO se dispara cuando el rol es ventas.
    const { enviar, creado } = crearPropuestaServiceParaEnvio(
      [item({ id: 1, estadoSurtido: EstadoSurtido.PENDIENTE, cantidadSurtida: 0 })],
      {
        pedidoEncontrado: {
          id: 1,
          estado: EstadoPedido.EN_ASESORIA,
          tiendaId: 5,
        },
      },
    );

    await enviar(
      1,
      {
        items: [{ itemId: 1, tipo: 'completo', producto: '', variante: '', cantidad: 5, precioUnitario: 100, subtotal: 500 }] as any,
        total: 500,
      },
      usuarioVentas,
    );

    expect(creado).toHaveLength(1);
  });
});

// =============================================================================
// T3 — H2 red de seguridad: aprobarPropuestaBodega vuelve a REVIEWING
//      si hay items PENDIENTE residuales
// =============================================================================

describe('T3 — H2 red: aprobarPropuestaBodega vuelve a REVIEWING si hay PENDIENTE', () => {
  it('transiciona a REVIEWING y consume la propuesta, no avanza a mostrador/pago', async () => {
    // Setup mínimo para `aprobarPropuestaBodega`.
    const transiciones: Array<{ nuevoEstado: EstadoPedido }> = [];

    const itemPedidoMock = {
      update: jest.fn(async () => ({})),
      // El guard "pedido sin productos" se evalúa con este count.
      count: jest.fn(async () => 2),
      // `recalcularTotalesPedido` no se llama en este path (la propuesta
      // se consume sin pasar por `aplicarCambiosDeBodega`), pero
      // mantenemos findMany por si alguna ruta lo invoca.
      findMany: jest.fn(async () => []),
    };

    const pedidoPropuestaMock = {
      update: jest.fn(async () => ({})),
    };

    const prisma = {
      pedido: {
        findUnique: jest.fn(async ({ where, include }: any) => {
          if (include?.items) {
            return {
              id: 1,
              estado: EstadoPedido.WAITING_CUSTOMER_APPROVAL,
              tiendaId: 5,
              modoEntrega: ModoEntrega.KIOSKO,
              descuento: new Prisma.Decimal(0),
              impuestos: new Prisma.Decimal(0),
              items: [
                item({ id: 1, estadoSurtido: EstadoSurtido.COMPLETO }),
                // El item fantasma que la red de seguridad debe atrapar.
                item({ id: 2, estadoSurtido: EstadoSurtido.PENDIENTE, cantidadSurtida: 0 }),
              ],
            };
          }
          return null;
        }),
      },
      itemPedido: itemPedidoMock,
      pedidoPropuesta: pedidoPropuestaMock,
      // La red de seguridad corre las cancelaciones dentro de `$transaction`.
      // Hacemos que `tx` reuse los mismos mocks para que las updates dentro
      // de la transacción queden registradas igual.
      $transaction: jest.fn(async (fn: (tx: any) => unknown) => {
        const tx = {
          itemPedido: itemPedidoMock,
          pedidoPropuesta: pedidoPropuestaMock,
        };
        return fn(tx);
      }),
    };

    const state = {
      cambiarEstado: jest.fn(async (_id: number, dto: any) => {
        transiciones.push({ nuevoEstado: dto.nuevoEstado });
        return { id: 1, estado: dto.nuevoEstado };
      }),
    };

    const svc = new PropuestaService(
      prisma as never,
      { emitToUser: jest.fn(), emitToPedido: jest.fn(), emitToTienda: jest.fn() } as never,
      { cargarYValidar: jest.fn() } as never,
      state as never,
      { crearDesdePedido: jest.fn() } as never,
      { columnaParaPedido: jest.fn() } as never,
    );

    const aprobar = (svc as any).aprobarPropuestaBodega.bind(svc);
    const dto = { decision: 'APROBAR' };
    const propuesta = { id: 7 };

    const result = await aprobar.call(
      svc,
      { id: 1, tiendaId: 5 },
      propuesta,
      dto,
      usuarioCliente,
      new Date(),
    );

    expect(result.estado).toBe(EstadoPedido.REVIEWING);
    expect(result.mensaje).toMatch(/quedaron pendientes/i);
    expect(transiciones).toHaveLength(1);
    expect(transiciones[0].nuevoEstado).toBe(EstadoPedido.REVIEWING);
  });
});

// =============================================================================
// T4 — H3: aplicarPropuestaDeVentas no debe dejar 0 items activos
// =============================================================================

describe('T4 — H3: ventas no avanza con 0 items activos', () => {
  it('lanza si la propuesta deja todos los items cancelados', async () => {
    // Partimos de 2 items, la propuesta dice "no-disponible" para ambos
    // y no agrega nada → 0 items activos.
    const prisma = {
      itemPedido: {
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          pedidoId: 1,
          cantidad: 5,
          precioUnitario: new Prisma.Decimal(100),
        })),
        update: jest.fn(async () => ({})),
        create: jest.fn(async () => ({})),
        count: jest.fn(async () => 0),
        // `recalcularTotalesPedido` lee items no cancelados para sumar
        // subtotales; sin este mock el helper falla con `findMany is not
        // a function`.
        findMany: jest.fn(async () => []),
      },
      precioCO: { findUnique: jest.fn() },
      pedido: { update: jest.fn() },
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

    await expect(
      aplicar(
        prisma,
        pedido,
        [
          { itemId: 1, tipo: 'no-disponible', producto: '', variante: '', cantidad: 5, precioUnitario: 100, subtotal: 500 },
          { itemId: 2, tipo: 'no-disponible', producto: '', variante: '', cantidad: 5, precioUnitario: 100, subtotal: 500 },
        ],
        [
          { id: 1, precioUnitario: new Prisma.Decimal(100) },
          { id: 2, precioUnitario: new Prisma.Decimal(100) },
        ],
        'precio1',
      ),
    ).rejects.toThrow(/dejaría el pedido sin productos/i);
  });
});

// =============================================================================
// T5/T6 — H4: quedanPendientes detecta items PARCIAL/NO_DISPONIBLE omitidos
// =============================================================================

describe('T5/T6 — H4: quedanPendientes refleja items no-COMPLETO residuales', () => {
  it('devuelve true cuando la propuesta omite un item PARCIAL residual', async () => {
    // El item 2 está en PARCIAL (bodega encontró 3 de 5). La propuesta
    // NO lo menciona. La propuesta debe hacer que el pedido vuelva a
    // bodega.
    const itemsActuales = [
      { id: 1, precioUnitario: new Prisma.Decimal(100) },
      {
        id: 2,
        precioUnitario: new Prisma.Decimal(100),
        estadoSurtido: EstadoSurtido.PARCIAL,
        cantidadSurtida: 3,
      },
    ];

    const prisma = {
      itemPedido: {
        findUnique: jest.fn(async ({ where }: any) => {
          const i = itemsActuales.find((x) => x.id === where.id);
          return i ?? null;
        }),
        update: jest.fn(async () => ({})),
        create: jest.fn(async () => ({})),
        // El cambio clave: el count usa `estadoSurtido: { not: 'COMPLETO' }`.
        // Como el item 2 está PARCIAL y NO se aplica la propuesta sobre él
        // (porque la propuesta solo lista el item 1), el count debe ser 1.
        count: jest.fn(async () => 1),
        // `recalcularTotalesPedido` requiere `findMany`.
        findMany: jest.fn(async () => []),
      },
      precioCO: { findUnique: jest.fn() },
      pedido: { update: jest.fn() },
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

    const result = await aplicar(
      prisma,
      pedido,
      [
        // La propuesta SOLO menciona el item 1 (completo → sin cambios).
        {
          itemId: 1,
          tipo: 'completo',
          producto: '',
          variante: '',
          cantidad: 5,
          precioUnitario: 100,
          subtotal: 500,
        },
      ],
      itemsActuales,
      'precio1',
    );

    expect(result.quedanPendientes).toBe(true);
  });
});

// =============================================================================
// T7/T8 — H5: marcarItem valida cantidad y cancelada
// =============================================================================

describe('T7/T8 — H5: marcarItem rechaza cantidades inválidas y cancelados', () => {
  function crearSurtidoConItem(itemData: any) {
    const prisma = {
      pedido: {
        findUnique: jest.fn(async () => ({
          id: 1,
          estado: EstadoPedido.REVIEWING,
          tiendaId: 5,
        })),
      },
      itemPedido: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === itemData.id ? { ...itemData } : null,
        ),
        update: jest.fn(async () => ({})),
      },
    };

    const svc = new SurtidoService(
      prisma as never,
      { cargarYValidar: jest.fn() } as never,
      { cambiarEstado: jest.fn() } as never,
      { enviar: jest.fn() } as never,
      { emitToPedido: jest.fn(), emitToTienda: jest.fn() } as never,
      { resolverImagen: jest.fn() } as never,
    );

    return { svc, marcar: svc.marcarItem.bind(svc) };
  }

  it('rechaza cantidadSurtida > cantidad', async () => {
    const { marcar } = crearSurtidoConItem({
      id: 1,
      pedidoId: 1,
      cantidad: 5,
      cancelada: false,
    });

    await expect(
      marcar(1, 1, {
        cantidadSurtida: 999,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }, usuarioBodega),
    ).rejects.toThrow(/no puede exceder la cantidad pedida/i);
  });

  it('rechaza items cancelada', async () => {
    const { marcar } = crearSurtidoConItem({
      id: 1,
      pedidoId: 1,
      cantidad: 5,
      cancelada: true,
    });

    await expect(
      marcar(1, 1, {
        cantidadSurtida: 3,
        estadoSurtido: EstadoSurtido.PARCIAL,
      }, usuarioBodega),
    ).rejects.toThrow(/item cancelado/i);
  });

  it('acepta un cambio válido sobre item no cancelado', async () => {
    const { marcar } = crearSurtidoConItem({
      id: 1,
      pedidoId: 1,
      cantidad: 5,
      cancelada: false,
    });

    await expect(
      marcar(1, 1, {
        cantidadSurtida: 5,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }, usuarioBodega),
    ).resolves.toBeDefined();
  });
});

// =============================================================================
// T9 — H6: mostrador `no-disponible` limpia el estado de surtido
// =============================================================================

describe('T9 — H6: mostrador `no-disponible` limpia estadoSurtido', () => {
  it('escribe cancelada:true, estadoSurtido:NO_DISPONIBLE, cantidadSurtida:0', async () => {
    const updates: Array<{ where: any; data: any }> = [];

    const tx = {
      itemPedido: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ where, data });
          return {};
        }),
        findUnique: jest.fn(async () => null),
      },
    };

    await aplicarCambiosFisicos(
      tx as never,
      {
        id: 1,
        tiendaId: 5,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
      },
      [
        {
          id: 1,
          estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          cantidadSurtida: 0,
          motivoSurtido: null,
        },
      ],
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({
      cancelada: true,
      estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      cantidadSurtida: 0,
    });
  });
});

// =============================================================================
// T10 — H7: el helper compartido produce los mismos resultados que las
//       copias que reemplaza (NO_DISPONIBLE cancela y limpia;
//       PARCIAL ajusta a cantidadSurtida con estadoSurtido: COMPLETO).
// =============================================================================

describe('T10 — H7: aplicarCambiosFisicos (helper unificado)', () => {
  it('NO_DISPONIBLE cancela y limpia estado y cantidad', async () => {
    const updates: any[] = [];
    const tx = {
      itemPedido: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ where, data });
          return {};
        }),
        findUnique: jest.fn(),
      },
    };

    await aplicarCambiosFisicos(
      tx as never,
      {
        id: 1,
        tiendaId: 5,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
      },
      [
        {
          id: 10,
          estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          cantidadSurtida: 0,
          motivoSurtido: null,
        },
      ],
    );

    expect(updates).toEqual([
      {
        where: { id: 10 },
        data: {
          cancelada: true,
          estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          cantidadSurtida: 0,
        },
      },
    ]);
  });

  it('PARCIAL ajusta cantidad y subtotal a cantidadSurtida, deja estadoSurtido:COMPLETO', async () => {
    const updates: any[] = [];
    const tx = {
      itemPedido: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ where, data });
          return {};
        }),
        findUnique: jest.fn(async ({ where }: any) => ({
          id: where.id,
          precioUnitario: new Prisma.Decimal(50),
        })),
      },
    };

    await aplicarCambiosFisicos(
      tx as never,
      {
        id: 1,
        tiendaId: 5,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
      },
      [
        {
          id: 20,
          estadoSurtido: EstadoSurtido.PARCIAL,
          cantidadSurtida: 3,
          motivoSurtido: 'pocas piezas',
        },
      ],
    );

    expect(updates).toEqual([
      {
        where: { id: 20 },
        data: {
          cantidad: 3,
          subtotal: new Prisma.Decimal(150),
          estadoSurtido: EstadoSurtido.COMPLETO,
        },
      },
    ]);
  });

  it('PARCIAL con cantidadSurtida=0 cancela (no deja activo con cantidad 0)', async () => {
    const updates: any[] = [];
    const tx = {
      itemPedido: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ where, data });
          return {};
        }),
        findUnique: jest.fn(),
      },
    };

    await aplicarCambiosFisicos(
      tx as never,
      {
        id: 1,
        tiendaId: 5,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
      },
      [
        {
          id: 30,
          estadoSurtido: EstadoSurtido.PARCIAL,
          cantidadSurtida: 0,
          motivoSurtido: null,
        },
      ],
    );

    expect(updates).toEqual([
      {
        where: { id: 30 },
        data: {
          cancelada: true,
          estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          cantidadSurtida: 0,
        },
      },
    ]);
  });

  it('COMPLETO no entra al helper (lo excluye el caller)', async () => {
    // El helper procesa NO_DISPONIBLE y PARCIAL. Los items COMPLETO no se
    // pasan — el caller los filtra antes. Si por error llega uno, no
    // produce cambios.
    const updates: any[] = [];
    const tx = {
      itemPedido: {
        update: jest.fn(async ({ where, data }: any) => {
          updates.push({ where, data });
          return {};
        }),
        findUnique: jest.fn(),
      },
    };

    await aplicarCambiosFisicos(
      tx as never,
      {
        id: 1,
        tiendaId: 5,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
      },
      [
        {
          id: 40,
          estadoSurtido: EstadoSurtido.COMPLETO,
          cantidadSurtida: 5,
          motivoSurtido: null,
        },
      ],
    );

    expect(updates).toEqual([]);
  });
});
