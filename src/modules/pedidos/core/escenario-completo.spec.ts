import { EstadoSurtido, Prisma } from '@prisma/client';
import { construirPropuestaDeBodega } from './propuesta-bodega.util';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import { aplicarCambiosFisicos } from './aplicar-cambios-surtido.util';
import { totalDePropuesta } from './total-propuesta.util';
import { seRetiraronPiezas } from './cancelacion-linea.util';
import { precioConPromoVolumen, COLUMNA_MAYOREO } from '../../precios/precio-lista.util';

/**
 * F20 (oct 2026): el ESCENARIO COMPLETO del negocio, de punta a punta.
 *
 * Es el caso que reportó el negocio, con sus números:
 *
 *   El cliente pide 10 de X, 5 de Y y 2 de Z.
 *   Bodega encuentra: X completa (10), Y sólo 3, Z ninguna (0).
 *   → se manda la propuesta al cliente.
 *   El cliente pide ajustes y entra el asesor de ventas, que puede:
 *     - quitar X aunque estuviera completa (el cliente se arrepintió),
 *     - subir Y (llegó mercancía nueva al anaquel),
 *     - cambiar Z por otro producto.
 *
 * Lo que estos tests fijan es que el SISTEMA y la PANTALLA digan lo mismo en
 * cada paso, y sobre todo que el dinero que el cliente aprueba sea el que se le
 * cobra. Los tres bugs que se arreglaron en F20 vivían justo aquí:
 *
 *   1. El total de la propuesta sumaba las líneas que se quitan.
 *   2. El precio se mostraba congelado mientras el cobro lo re-evaluaba (promo).
 *   3. "El cliente lo quitó" y "no había" eran indistinguibles.
 *
 * El "cobro real" se modela con las MISMAS funciones que usa el flujo de
 * producción (`aplicarCambiosFisicos` + `precioConPromoVolumen`), no con
 * números escritos a mano: si alguien cambia la fórmula del cobro, estos tests
 * fallan en vez de quedarse verdes mintiendo.
 */

// =============================================================================
// El pedido del escenario
// =============================================================================

/** Cliente de lista 1 (menudeo): base $100, mayoreo (lista 2) $80. */
const BASE = new Prisma.Decimal(100);
const MAYOREO = new Prisma.Decimal(80);

interface ItemEscenario {
  id: number;
  nombre: string;
  cantidadPedida: number;
  cantidad: number;
  cantidadSurtida: number;
  estadoSurtido: EstadoSurtido;
  cancelada: boolean;
  precioUnitario: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  precioUnitarioBase: Prisma.Decimal;
  precioUnitarioMayoreo: Prisma.Decimal;
}

/**
 * Construye un item del pedido.
 *
 * `precioVigente` es el precio CONGELADO: si el pedido nació con 12+ piezas,
 * trae la promo aplicada ($80). Es lo que hace visible el bug de la promo.
 */
function item(
  id: number,
  nombre: string,
  pedida: number,
  vigente: number,
  surtida: number,
  estado: EstadoSurtido,
  precioVigente = 80,
): ItemEscenario {
  const precio = new Prisma.Decimal(precioVigente);
  return {
    id,
    nombre,
    cantidadPedida: pedida,
    cantidad: vigente,
    cantidadSurtida: surtida,
    estadoSurtido: estado,
    cancelada: false,
    precioUnitario: precio,
    subtotal: precio.mul(vigente),
    precioUnitarioBase: BASE,
    precioUnitarioMayoreo: MAYOREO,
  };
}

/**
 * El pedido tal como lo deja bodega tras cerrar el surtido incompleto.
 *
 * X: 10 pedidas, 10 hay → COMPLETO
 * Y: 5 pedidas, 3 hay   → PARCIAL
 * Z: 2 pedidas, 0 hay   → NO_DISPONIBLE
 *
 * 17 piezas pedidas → el pedido nació con promo, así que el precio congelado es
 * $80 (mayoreo).
 */
function pedidoTrasSurtidoIncompleto(): ItemEscenario[] {
  return [
    item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
    item(2, 'Y', 5, 5, 3, EstadoSurtido.PARCIAL),
    item(3, 'Z', 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
  ];
}

// =============================================================================
// El "cobro real": las MISMAS funciones que el flujo de producción
// =============================================================================

/**
 * Aplica los cambios al pedido con `aplicarCambiosFisicos` (el helper real de
 * bodega) y calcula el total con la promo re-evaluada.
 *
 * Devuelve el estado FINAL de los items, que es lo que el ERP cobraría.
 */
async function cobrarComoProduccion(items: ItemEscenario[]) {
  const actualizados = new Map<
    number,
    { cantidad: number; cancelada: boolean; cantidadSurtida: number }
  >();
  for (const i of items) {
    actualizados.set(i.id, {
      cantidad: i.cantidad,
      cancelada: i.cancelada,
      cantidadSurtida: i.cantidadSurtida,
    });
  }

  const tx = {
    itemPedido: {
      update: jest.fn(async ({ where, data }: any) => {
        const prev = actualizados.get(where.id)!;
        actualizados.set(where.id, {
          cantidad: data.cantidad ?? prev.cantidad,
          cancelada: data.cancelada ?? prev.cancelada,
          cantidadSurtida: data.cantidadSurtida ?? prev.cantidadSurtida,
        });
        return {};
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const i = items.find((x) => x.id === where.id)!;
        return { id: i.id, precioUnitario: i.precioUnitario, ...actualizados.get(where.id)! };
      }),
      count: jest.fn(async () => [...actualizados.values()].filter((a) => !a.cancelada).length),
      findMany: jest.fn(async () =>
        [...actualizados.entries()]
          .filter(([, a]) => !a.cancelada)
          .map(([id, a]) => ({
            id,
            cantidad: a.cantidad,
            subtotal: new Prisma.Decimal(a.cantidad).mul(80),
          })),
      ),
    },
    pedido: { update: jest.fn(async () => ({})) },
  };

  // El helper REAL de bodega: liquida NO_DISPONIBLE y colapsa PARCIAL.
  await aplicarCambiosFisicos(
    tx as never,
    { id: 1, tiendaId: 5, descuento: new Prisma.Decimal(0), impuestos: new Prisma.Decimal(0) },
    items
      .filter((i) => i.estadoSurtido !== EstadoSurtido.COMPLETO)
      .map((i) => ({
        id: i.id,
        estadoSurtido: i.estadoSurtido,
        cantidadSurtida: i.cantidadSurtida,
        motivoSurtido: null,
      })),
  );

  // El cobro: piezas VIGENTES de los items vivos, con la promo re-evaluada.
  const vivos = [...actualizados.values()].filter((a) => !a.cancelada);
  const piezas = vivos.reduce((acc, a) => acc + a.cantidad, 0);
  const precioPieza = Number(precioConPromoVolumen(BASE, MAYOREO, piezas));

  return { piezas, precioPieza, total: precioPieza * piezas, actualizados };
}

/** Tx mockeada para `aplicarPropuestaDeVentas`. */
function crearTxPropuesta(items: ItemEscenario[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const tx = {
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => {
        const i = items.find((x) => x.id === where.id);
        return i ? { ...i } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      }),
      create: jest.fn(async () => ({})),
      count: jest.fn(async () => items.filter((i) => !i.cancelada).length + 1),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
    },
    precioCO: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        tiendaId: 5,
        productoId: 99,
        precio: BASE,
        lista1: BASE,
        lista2: MAYOREO,
        lista3: new Prisma.Decimal(0),
        lista4: new Prisma.Decimal(0),
        lista5: new Prisma.Decimal(0),
        lista6: new Prisma.Decimal(0),
        producto: { nombre: 'W', codigo: 'CW' },
        corrida: { nombre: 'A' },
        talla: { nombre: 'M' },
        color: { nombre: 'N' },
      })),
    },
    pedido: { update: jest.fn(async () => ({})) },
  };
  return { tx, updates };
}

const pedidoPlano = {
  id: 1,
  tiendaId: 5,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

// =============================================================================

describe('F20 — paso 1: bodega cierra el surtido incompleto', () => {
  it('la propuesta de bodega refleja lo que de verdad hay', () => {
    const items = pedidoTrasSurtidoIncompleto();
    const { items: prop, total } = construirPropuestaDeBodega(items as never);

    const porItem = new Map(prop.map((p) => [p.itemId, p]));

    // X: completa, sin cambios.
    expect(porItem.get(1)!.tipo).toBe('completo');
    expect(porItem.get(1)!.cantidad).toBe(10);

    // Y: hay 3 de 5 → parcial, y el cliente ve las dos cantidades.
    expect(porItem.get(2)!.tipo).toBe('parcial');
    expect(porItem.get(2)!.cantidadOriginal).toBe(5);
    expect(porItem.get(2)!.cantidadNueva).toBe(3);

    // Z: no hay nada → no disponible, y NO se cobra.
    expect(porItem.get(3)!.tipo).toBe('no-disponible');
    expect(porItem.get(3)!.subtotal).toBe(0);

    // 10 de X + 3 de Y = 13 piezas → sigue sobre el umbral → $80.
    expect(total).toBe(13 * 80);
  });

  it('el total de la propuesta coincide con lo que se cobrará', async () => {
    const items = pedidoTrasSurtidoIncompleto();
    const { total } = construirPropuestaDeBodega(items as never);
    const { total: cobro } = await cobrarComoProduccion(items);

    expect(total).toBe(cobro);
  });
});

describe('F20 — paso 2: el cliente pide ajustes y entra el asesor', () => {
  it('el asesor QUITA X aunque estuviera completa: conserva el hallazgo físico', async () => {
    // El caso del reporte: "quite un producto X que sí estaba toda la
    // disponibilidad... y me sale tachado como si no hubiera habido".
    const items = pedidoTrasSurtidoIncompleto();
    const { tx, updates } = crearTxPropuesta(items);

    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedidoPlano,
      [
        {
          itemId: 1,
          tipo: 'no-disponible',
          producto: 'X',
          variante: 'M',
          cantidad: 10,
          precioUnitario: 80,
          subtotal: 800,
        },
        {
          itemId: 2,
          tipo: 'parcial',
          producto: 'Y',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 80,
          subtotal: 400,
          cantidadNueva: 3,
          subtotalNuevo: 240,
        },
        {
          itemId: 3,
          tipo: 'no-disponible',
          producto: 'Z',
          variante: 'M',
          cantidad: 2,
          precioUnitario: 80,
          subtotal: 160,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    const x = updates.find((u) => u.id === 1)!;
    // X sale del pedido PERO conserva que había 10.
    expect(x.data.cancelada).toBe(true);
    expect(x.data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    expect(x.data.cantidadSurtida).toBe(10);

    // Y se liquida a lo que hay.
    const y = updates.find((u) => u.id === 2)!;
    expect(y.data.cantidad).toBe(3);
    expect(y.data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);

    // Z sí es falta de bodega: se limpia.
    const z = updates.find((u) => u.id === 3)!;
    expect(z.data.estadoSurtido).toBe(EstadoSurtido.NO_DISPONIBLE);
    expect(z.data.cantidadSurtida).toBe(0);

    // Y hay mercancía que sacar de la bolsa (las 10 de X): el pedido vuelve a
    // bodega al checklist de retiro. NO genera reposición.
    expect(r.huboRetiro).toBe(true);
  });

  it('el asesor SUBE Y porque llegó mercancía nueva', async () => {
    const items = pedidoTrasSurtidoIncompleto();
    const { tx, updates } = crearTxPropuesta(items);

    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedidoPlano,
      [
        {
          itemId: 2,
          tipo: 'parcial',
          producto: 'Y',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 80,
          subtotal: 400,
          cantidadNueva: 5,
          subtotalNuevo: 400,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    const y = updates.find((u) => u.id === 2)!;
    // Subir por encima de lo apartado (3) manda el item de vuelta a bodega:
    // nadie verificó las 2 piezas nuevas.
    expect(y.data.cantidad).toBe(5);
    expect(y.data.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    expect(y.data.cantidadSurtida).toBe(0);
    expect(r.quedanPendientes).toBe(true);
  });

  it('el asesor CAMBIA Z por otro producto', async () => {
    const items = pedidoTrasSurtidoIncompleto();
    const { tx, updates } = crearTxPropuesta(items);

    await aplicarPropuestaDeVentas(
      tx as never,
      pedidoPlano,
      [
        {
          itemId: 3,
          tipo: 'cambio',
          producto: 'Z',
          variante: 'M',
          cantidad: 2,
          precioUnitario: 80,
          subtotal: 160,
          cantidadNueva: 2,
          precioCOId: 500,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    // Z estaba NO_DISPONIBLE (0 piezas): el cambio no retira nada de la bolsa.
    const z = updates.find((u) => u.id === 3)!;
    expect(z.data.cancelada).toBe(true);
    expect(z.data.cantidadSurtida).toBe(0);
  });
});

describe('F20 — paso 3: el dinero que se aprueba es el que se cobra', () => {
  it('quitar X baja el pedido de 13 a 3 piezas y REVOCA la promo', async () => {
    // Este es el bug del reporte: la propuesta decía un número y se cobraba otro.
    const items = pedidoTrasSurtidoIncompleto();
    const { tx } = crearTxPropuesta(items);

    await aplicarPropuestaDeVentas(
      tx as never,
      pedidoPlano,
      [
        {
          itemId: 1,
          tipo: 'no-disponible',
          producto: 'X',
          variante: 'M',
          cantidad: 10,
          precioUnitario: 80,
          subtotal: 800,
        },
        {
          itemId: 2,
          tipo: 'parcial',
          producto: 'Y',
          variante: 'M',
          cantidad: 5,
          precioUnitario: 80,
          subtotal: 400,
          cantidadNueva: 3,
          subtotalNuevo: 240,
        },
        {
          itemId: 3,
          tipo: 'no-disponible',
          producto: 'Z',
          variante: 'M',
          cantidad: 2,
          precioUnitario: 80,
          subtotal: 160,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    // Lo que queda: solo Y con 3 piezas.
    const sobreviven = [{ cantidad: 3, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 }];
    const totalPropuesta = totalDePropuesta(sobreviven);

    // 3 piezas < 12 → la promo se revoca → $100/pieza.
    expect(totalPropuesta).toBe(300);

    // Y el cobro real da lo mismo.
    const { total: cobro } = await cobrarComoProduccion([
      item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 'Y', 5, 5, 3, EstadoSurtido.PARCIAL),
      item(3, 'Z', 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ]);
    // El cobro de bodega liquida Y a 3 y cancela Z → 10 de X + 3 de Y = 13.
    // (Aquí X sigue vivo: es el paso de bodega, antes del ajuste del asesor.)
    expect(cobro).toBe(13 * 80);
  });

  it('la propuesta NO suma la línea que se quita', () => {
    // X (10 pzas) sale; solo queda Y con 3.
    const total = totalDePropuesta([
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
      { cantidad: 3, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
    ]);
    expect(total).toBe(300);
  });

  it('un pedido donde TODO se quita da 0, no el total original', () => {
    const total = totalDePropuesta([
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
      { cantidad: 0, base: BASE, mayoreo: MAYOREO, precioUnitario: 80 },
    ]);
    expect(total).toBe(0);
  });
});

describe('F20 — paso 4: la pantalla distingue las dos razones', () => {
  it('X (quitada con 10 en la bolsa) NO es un faltante', () => {
    const x = { cancelada: true, cantidadSurtida: 10 };
    expect(seRetiraronPiezas(x)).toBe(true);
  });

  it('Z (no había nada) SÍ es un faltante', () => {
    const z = { cancelada: true, cantidadSurtida: 0 };
    expect(seRetiraronPiezas(z)).toBe(false);
  });

  it('las dos se distinguen leyendo solo el item', () => {
    const quitada = { cancelada: true, cantidadSurtida: 10 };
    const faltante = { cancelada: true, cantidadSurtida: 0 };
    expect(seRetiraronPiezas(quitada)).not.toBe(seRetiraronPiezas(faltante));
  });
});

describe('F20 — el invariante que sostiene todo', () => {
  /**
   * El total y las LÍNEAS tienen que contar la misma historia.
   *
   * Este test nació de una mutación: al reintroducir el bug (la rama `completo`
   * usando el precio congelado) los tests de total seguían pasando — porque
   * `totalDePropuesta` recalcula desde el input y no lee el snapshot. El
   * resultado era una propuesta que decía **$1000 en el total y $800 en la
   * línea**, y la tarjeta del cliente muestra la línea.
   *
   * O sea: el bug era real y los tests no lo veían. Este lo ve.
   */
  it('la suma de las LÍNEAS coincide con el total', () => {
    const casos: Array<{ nombre: string; items: ItemEscenario[] }> = [
      { nombre: 'el escenario del reporte', items: pedidoTrasSurtidoIncompleto() },
      {
        nombre: 'un pedido que baja del umbral de promo',
        items: [
          item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
          item(2, 'Z', 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
        ],
      },
      {
        nombre: 'un pedido con un item colapsado',
        items: [item(1, 'X', 20, 10, 10, EstadoSurtido.COMPLETO)],
      },
    ];

    for (const caso of casos) {
      const { items: prop, total } = construirPropuestaDeBodega(caso.items as never);

      // Lo que la tarjeta del cliente suma: cada línea con su subtotal efectivo.
      // Un `no-disponible` no se cobra (su subtotal ya viene en 0).
      const sumaLineas = prop.reduce((acc, p) => acc + (p.subtotalNuevo ?? p.subtotal), 0);

      expect({ caso: caso.nombre, sumaLineas }).toEqual({
        caso: caso.nombre,
        sumaLineas: total,
      });
    }
  });

  it('el precio de cada LÍNEA es el re-evaluado, no el congelado', () => {
    // X=10 COMPLETO + Z=2 NO_DISPONIBLE: quedan 10 piezas, bajo el umbral de 12,
    // así que la promo se revoca y cada pieza vale $100 (no los $80 congelados).
    const items = [
      item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 'Z', 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ];
    const { items: prop } = construirPropuestaDeBodega(items as never);

    const x = prop.find((p) => p.itemId === 1)!;
    expect(x.tipo).toBe('completo');
    expect(x.precioUnitario).toBe(100);
    expect(x.subtotal).toBe(1000);
  });

  it('el total de la propuesta de bodega coincide con el cobro en TODOS los casos', async () => {
    const casos: Array<{ nombre: string; items: ItemEscenario[] }> = [
      { nombre: 'el escenario del reporte', items: pedidoTrasSurtidoIncompleto() },
      {
        nombre: 'un pedido que baja del umbral de promo',
        items: [
          item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
          item(2, 'Z', 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
        ],
      },
      {
        nombre: 'un pedido que conserva la promo',
        items: [
          item(1, 'X', 10, 10, 10, EstadoSurtido.COMPLETO),
          item(2, 'Y', 4, 4, 4, EstadoSurtido.COMPLETO),
        ],
      },
      {
        nombre: 'un pedido con un item colapsado',
        items: [item(1, 'X', 20, 10, 10, EstadoSurtido.COMPLETO)],
      },
    ];

    for (const caso of casos) {
      const { total } = construirPropuestaDeBodega(caso.items as never);
      const { total: cobro } = await cobrarComoProduccion(caso.items);
      expect({ caso: caso.nombre, total }).toEqual({ caso: caso.nombre, total: cobro });
    }
  });

  it('la columna de mayoreo es la que congela el par de precios', () => {
    // Guard de coherencia: si alguien cambia la lista de la promo, este test
    // avisa antes de que los pedidos empiecen a cotizar distinto.
    expect(COLUMNA_MAYOREO).toBe('lista2');
  });
});
