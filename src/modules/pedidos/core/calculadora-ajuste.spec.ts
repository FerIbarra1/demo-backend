import { EstadoSurtido, Prisma } from '@prisma/client';
import { calcularAjuste } from './calculadora-ajuste.util';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import { construirPropuestaDeBodega } from './propuesta-bodega.util';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';

/**
 * F20 (oct 2026): el total de una propuesta tiene que salir de la MISMA regla
 * que el cobro.
 *
 * Los dos bugs que estos tests fijan, ambos del mismo error de fondo (mostrar
 * un número que no sale de la función que cobra):
 *
 *   1. Se sumaban las líneas que la propuesta QUITA. Un `no-disponible` trae el
 *      subtotal de la cantidad PEDIDA, así que inflaba el total.
 *   2. Se usaba el precio CONGELADO en el item, pero el cobro lo RE-EVALÚA
 *      (`aplicarPromoVolumen`). La promo de volumen se revoca al bajar de 12.
 *
 * Los casos usan un cliente de lista 1 (base $100, mayoreo $80) — el único que
 * la promo puede beneficiar.
 */

const BASE = new Prisma.Decimal(100);
const MAYOREO = new Prisma.Decimal(80);

/** El cobro REAL: modelo exacto de `aplicarCambiosFisicos` + `aplicarPromoVolumen`. */
function cobroReal(
  items: Array<{ estadoSurtido: EstadoSurtido; cantidad: number; cantidadSurtida: number }>,
): number {
  const tras: Array<{ cancelada: boolean; cantidad: number }> = items.map((i) => {
    if (i.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) {
      return { cancelada: true, cantidad: i.cantidad };
    }
    if (i.estadoSurtido === EstadoSurtido.PARCIAL) {
      return { cancelada: false, cantidad: i.cantidadSurtida };
    }
    return { cancelada: false, cantidad: i.cantidad };
  });
  const vivos = tras.filter((i) => !i.cancelada);
  const piezas = vivos.reduce((a, i) => a + i.cantidad, 0);
  return Number(precioConPromoVolumen(BASE, MAYOREO, piezas)) * piezas;
}

/** Item de pedido con el par de precios congelado (nació con 12+ piezas). */
function item(id: number, pedida: number, vigente: number, surtida: number, estado: EstadoSurtido) {
  const precio = new Prisma.Decimal(80);
  return {
    id,
    productoNombre: `P${id}`,
    productoCodigo: `C${id}`,
    corridaNombre: 'A',
    tallaNombre: 'M',
    colorNombre: 'N',
    cantidadPedida: pedida,
    cantidad: vigente,
    cantidadSurtida: surtida,
    estadoSurtido: estado,
    cancelada: false,
    precioUnitario: precio,
    precioUnitarioBase: BASE,
    precioUnitarioMayoreo: MAYOREO,
    subtotal: precio.mul(vigente),
  };
}

// =============================================================================
// Fase 2 (oct 2026): la calculadora de ajuste
// =============================================================================
//
// `calcularAjuste` es la UNICA función que decide qué dice una propuesta y cuánto
// cuesta: la usa bodega (sin intenciones), el editor del asesor (vista previa) y
// el envío de la contrapropuesta. Lo que sigue la prueba por dentro y, sobre todo,
// contra el aplicador REAL (`aplicarPropuestaDeVentas` + `recalcularTotalesPedido`)
// sobre una BD en memoria: el total que el cliente aprueba es el que se cobra.

const D = (n: number) => new Prisma.Decimal(n);

/** Un item del pedido ya colapsado, con precio y par congelados (seed: lista1/lista2). */
function fila(
  id: number,
  over: Partial<Record<string, unknown>> & {
    base?: number;
    mayoreo?: number;
    cantidad?: number;
  } = {},
) {
  const base = over.base ?? 100;
  const mayoreo = over.mayoreo ?? 80;
  const cantidad = (over.cantidad as number) ?? 5;
  return {
    id,
    pedidoId: 1,
    productoNombre: `P${id}`,
    productoCodigo: `C${id}`,
    productoId: 100 + id,
    precioCOId: 200 + id,
    corridaNombre: 'Adulto',
    tallaNombre: 'M',
    colorNombre: 'N',
    cantidadPedida: cantidad,
    cantidad,
    cantidadSurtida: cantidad,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    precioUnitario: D(base),
    precioUnitarioBase: D(base),
    precioUnitarioMayoreo: D(mayoreo),
    subtotal: D(base).mul(cantidad),
    ...over,
  } as any;
}

const AGREGADO = {
  precioCOId: 9,
  productoId: 99,
  productoNombre: 'Nueva',
  productoCodigo: 'CN',
  productoImagen: null,
  variante: 'Adulto · M · N',
  precioBase: D(60),
  precioMayoreo: D(57),
};

describe('calcularAjuste — la regla del total', () => {
  it('no suma una línea que sale del pedido', () => {
    const { total } = calcularAjuste(
      [fila(1, { cantidad: 10 }), fila(2, { cantidad: 3 })],
      [{ accion: 'QUITAR', itemId: 2 }],
    );
    // 10 piezas → bajo el umbral → precio base $100.
    expect(total).toBe(1000);
  });

  it('decide la promo con el total FINAL, no con el acumulado parcial', () => {
    // Dos líneas de 6: por separado ninguna llega a 12, juntas sí.
    const { total } = calcularAjuste([fila(1, { cantidad: 6 }), fila(2, { cantidad: 6 })], []);
    // 12 piezas → mayoreo $80 → 960. En una pasada daría 6×100 + 6×80 = 1080.
    expect(total).toBe(960);
  });

  it('sin par congelado usa el precio del item (pedidos viejos)', () => {
    const viejo = fila(1, { cantidad: 10, precioUnitarioBase: null, precioUnitarioMayoreo: null });
    expect(calcularAjuste([viejo], []).total).toBe(1000);
  });

  it('un pedido donde TODO sale da 0, no el total original', () => {
    const { total, hayCambios } = calcularAjuste(
      [fila(1), fila(2)],
      [
        { accion: 'QUITAR', itemId: 1 },
        { accion: 'QUITAR', itemId: 2 },
      ],
    );
    expect(total).toBe(0);
    expect(hayCambios).toBe(true);
  });
});

describe('calcularAjuste — qué es una decisión', () => {
  it('sin intenciones describe el pedido y no hay nada que enviar', () => {
    const r = calcularAjuste([fila(1, { cantidad: 4 })], []);
    expect(r.hayCambios).toBe(false);
    expect(r.items[0].tipo).toBe('completo');
    expect(r.total).toBe(400);
  });

  it('una CANTIDAD igual a la actual NO es un cambio', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 4 })],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 4 }],
    );
    expect(r.hayCambios).toBe(false);
    expect(r.items[0].ajusteExplicito).toBeUndefined();
  });

  it('CANTIDAD que SUBE: decisión explícita, "Hay N" conservado y piezas por surtir', () => {
    // Pidió 1, hay 1, el asesor la sube a 3 → bodega tiene que surtir 2 más.
    const r = calcularAjuste(
      [fila(1, { cantidad: 1 })],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 3 }],
    );
    const l = r.items[0];
    expect(l.tipo).toBe('parcial');
    expect(l.ajusteExplicito).toBe(true);
    expect(l.cantidadOriginal).toBe(1);
    expect(l.cantidadNueva).toBe(3);
    expect(l.cantidadDisponible).toBe(1);
    expect(l.piezasPorSurtir).toBe(2);
    expect(r.piezasPorSurtir).toBe(2);
    expect(r.hayCambios).toBe(true);
  });

  it('CANTIDAD que BAJA no pide surtir nada', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 5 })],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 2 }],
    );
    expect(r.piezasPorSurtir).toBe(0);
    expect(r.items[0].piezasPorSurtir).toBeUndefined();
  });

  it('puede llevarse MÁS de lo que pidió al inicio (decisión del dueño)', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 5 })],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 9 }],
    );
    expect(r.items[0].cantidadNueva).toBe(9);
    expect(r.piezasPorSurtir).toBe(4);
  });

  it('las piezas que un ajuste anterior ya sacó no cuentan como "en la bolsa"', () => {
    // Hallazgo 5, ya sacaron 2 → en la bolsa hay 3. Subir a 4 deja UNA por surtir.
    const it = fila(1, { cantidad: 3, cantidadSurtida: 5, piezasRetiradas: 2, cantidadPedida: 5 });
    const r = calcularAjuste([it], [{ accion: 'CANTIDAD', itemId: 1, cantidad: 4 }]);
    expect(r.piezasPorSurtir).toBe(1);
  });

  it('QUITAR: sale del pedido, no se cobra y conserva lo que valía', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 4 }), fila(2, { cantidad: 2 })],
      [{ accion: 'QUITAR', itemId: 1 }],
    );
    const l = r.items.find((i) => i.itemId === 1)!;
    expect(l.tipo).toBe('no-disponible');
    expect(l.ajusteExplicito).toBe(true);
    expect(l.subtotal).toBe(0);
    expect(l.subtotalOriginal).toBe(400);
    expect(l.cantidadDisponible).toBe(4);
    expect(r.total).toBe(200);
    expect(r.totalAntes).toBe(600);
  });

  it('AGREGAR: tempId negativo, precio de la lista del cliente con la promo re-evaluada', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 8 })],
      [{ accion: 'AGREGAR', precioCOId: 9, cantidad: 6 }],
      [AGREGADO],
    );
    const a = r.items.find((i) => i.tipo === 'agregado')!;
    expect(a.itemId).toBe(-1);
    expect(a.precioCOId).toBe(9);
    // 14 piezas ≥ 12: el agregado entra a mayoreo ($57), como en el cobro.
    expect(a.precioUnitario).toBe(57);
    expect(a.subtotal).toBe(342);
    expect(a.piezasPorSurtir).toBe(6);
    // Y las líneas existentes también ganan la promo: 8 × $80 + 6 × $57.
    expect(r.total).toBe(8 * 80 + 342);
  });
});

describe('calcularAjuste — el ejemplo del reporte (7 → 18 piezas)', () => {
  const pedido = () => [
    fila(1, { base: 65, mayoreo: 61.75, cantidad: 1 }),
    fila(2, { base: 60, mayoreo: 57, cantidad: 1 }),
    // Pidió 5, bodega encontró 3 y quedó colapsada a 3.
    fila(3, { base: 65, mayoreo: 61.75, cantidad: 3, cantidadPedida: 5, cantidadSurtida: 3 }),
  ];
  const intenciones = [
    { accion: 'CANTIDAD' as const, itemId: 1, cantidad: 3 },
    { accion: 'CANTIDAD' as const, itemId: 2, cantidad: 10 },
    { accion: 'CANTIDAD' as const, itemId: 3, cantidad: 5 },
  ];

  it('las líneas SUMAN el total: $1,064, no $1,120', () => {
    const r = calcularAjuste(pedido(), intenciones);
    const sumaLineas = r.items.reduce((a, l) => a + (l.subtotalNuevo ?? l.subtotal), 0);
    expect(r.total).toBe(1064);
    expect(sumaLineas).toBe(1064);
  });

  it('avisa que el mayoreo depende de que bodega confirme las piezas nuevas', () => {
    const r = calcularAjuste(pedido(), intenciones);
    // 18 piezas; en la bolsa hay 1 + 1 + 3 = 5 → 13 sin verificar. Sin ellas, 5 < 12.
    expect(r.piezasFinales).toBe(18);
    expect(r.piezasPorSurtir).toBe(13);
    expect(r.mayoreoCondicional).toBe(true);
    expect(r.items.every((l) => l.mayoreoCondicional === true)).toBe(true);
  });

  it('con pocas piezas sin verificar la promo no depende de nadie', () => {
    // 12 en la bolsa + 6 nuevas: aunque bodega no encuentre las 6, quedan 12.
    const r = calcularAjuste(
      [fila(1, { cantidad: 12 })],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 18 }],
    );
    expect(r.mayoreoCondicional).toBe(false);
    expect(r.items[0].mayoreoCondicional).toBeUndefined();
  });

  it('un cliente de lista 3..6 (base más barata que el mayoreo) no recibe el aviso', () => {
    const it = fila(1, { cantidad: 1, base: 70, mayoreo: 80 });
    const r = calcularAjuste([it], [{ accion: 'CANTIDAD', itemId: 1, cantidad: 15 }]);
    expect(r.mayoreoCondicional).toBe(false);
  });
});

describe('calcularAjuste — valida la intención', () => {
  const items = [fila(1), fila(2)];

  it.each([
    [
      'un item que no es del pedido',
      [{ accion: 'QUITAR' as const, itemId: 99 }],
      /no pertenece al pedido/,
    ],
    [
      'dos cambios sobre la misma línea',
      [
        { accion: 'QUITAR' as const, itemId: 1 },
        { accion: 'CANTIDAD' as const, itemId: 1, cantidad: 2 },
      ],
      /dos cambios a la vez/,
    ],
    [
      'CANTIDAD en 0 (para sacar la línea es QUITAR)',
      [{ accion: 'CANTIDAD' as const, itemId: 1, cantidad: 0 }],
      /QUITAR/,
    ],
    [
      'una cantidad con decimales',
      [{ accion: 'CANTIDAD' as const, itemId: 1, cantidad: 1.5 }],
      /entero/,
    ],
    [
      'agregar una variante que el pedido ya tiene',
      [{ accion: 'AGREGAR' as const, precioCOId: 201, cantidad: 1 }],
      /ya está en el pedido/,
    ],
    [
      'agregar sin piezas',
      [{ accion: 'AGREGAR' as const, precioCOId: 9, cantidad: 0 }],
      /al menos 1 pieza/,
    ],
    [
      'agregar la misma variante dos veces',
      [
        { accion: 'AGREGAR' as const, precioCOId: 9, cantidad: 1 },
        { accion: 'AGREGAR' as const, precioCOId: 9, cantidad: 2 },
      ],
      /dos veces/,
    ],
    [
      'una variante que no se resolvió',
      [{ accion: 'AGREGAR' as const, precioCOId: 777, cantidad: 1 }],
      /no se pudo resolver/,
    ],
  ])('rechaza %s', (_n, intenciones, mensaje) => {
    expect(() => calcularAjuste(items, intenciones, [AGREGADO])).toThrow(mensaje);
  });

  it('una línea cancelada ya no se puede tocar', () => {
    expect(() =>
      calcularAjuste([fila(1), fila(2, { cancelada: true })], [{ accion: 'QUITAR', itemId: 2 }]),
    ).toThrow(/no pertenece al pedido/);
  });
});

// -----------------------------------------------------------------------------
// El total propuesto contra el cobro REAL
// -----------------------------------------------------------------------------

/**
 * BD en memoria con lo justo para correr `aplicarPropuestaDeVentas` y
 * `recalcularTotalesPedido` (que re-evalúa la promo) de verdad. A diferencia de
 * los mocks estáticos de otros specs, ESTA recuerda lo que se escribe, así que
 * el total que sale es el que se cobraría.
 */
function bdEnMemoria(inicial: any[]) {
  const filas = inicial.map((f) => ({ ...f }));
  let cobrado = 0;
  const cumple = (f: any, where: Record<string, any> = {}) =>
    Object.entries(where).every(([k, v]) =>
      k === 'estadoSurtido' && v && typeof v === 'object' ? f.estadoSurtido !== v.not : f[k] === v,
    );
  const catalogo: Record<number, any> = {
    9: {
      id: 9,
      tiendaId: 5,
      productoId: 99,
      precio: D(60),
      lista1: D(60),
      lista2: D(57),
      lista3: D(0),
      lista4: D(0),
      lista5: D(0),
      lista6: D(0),
      producto: { nombre: 'Nueva', codigo: 'CN' },
      corrida: { nombre: 'Adulto' },
      talla: { nombre: 'M' },
      color: { nombre: 'N' },
    },
  };
  const tx = {
    itemPedido: {
      findUnique: async ({ where }: any) => filas.find((f) => f.id === where.id) ?? null,
      findMany: async ({ where }: any) => filas.filter((f) => cumple(f, where)),
      count: async ({ where }: any) => filas.filter((f) => cumple(f, where)).length,
      update: async ({ where, data }: any) =>
        Object.assign(filas.find((f) => f.id === where.id)!, data),
      create: async ({ data }: any) => {
        filas.push({ id: 500 + filas.length, cancelada: false, ...data });
        return {};
      },
    },
    precioCO: { findUnique: async ({ where }: any) => catalogo[where.id] ?? null },
    pedido: {
      update: async ({ data }: any) => {
        cobrado = Number(data.total);
        return {};
      },
    },
  };
  return { tx, cobrado: () => cobrado };
}

describe('calcularAjuste — el total propuesto es el que se COBRA al aprobar', () => {
  const pedidoPlano = { id: 1, tiendaId: 5, descuento: D(0), impuestos: D(0) };

  /** Calcula, aplica con el aplicador real y compara los dos totales. */
  async function propuestoVsCobrado(
    items: any[],
    intenciones: Parameters<typeof calcularAjuste>[1],
    agregados: Parameters<typeof calcularAjuste>[2] = [],
  ) {
    const calculo = calcularAjuste(items, intenciones, agregados);
    const bd = bdEnMemoria(items);
    await aplicarPropuestaDeVentas(
      bd.tx as never,
      pedidoPlano,
      calculo.items as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );
    return { propuesto: calculo.total, cobrado: bd.cobrado() };
  }

  it('el ejemplo del reporte: 7 → 18 piezas, la promo ENTRA', async () => {
    const items = [
      fila(1, { base: 65, mayoreo: 61.75, cantidad: 1 }),
      fila(2, { base: 60, mayoreo: 57, cantidad: 1 }),
      fila(3, { base: 65, mayoreo: 61.75, cantidad: 3, cantidadPedida: 5, cantidadSurtida: 3 }),
    ];
    const { propuesto, cobrado } = await propuestoVsCobrado(items, [
      { accion: 'CANTIDAD', itemId: 1, cantidad: 3 },
      { accion: 'CANTIDAD', itemId: 2, cantidad: 10 },
      { accion: 'CANTIDAD', itemId: 3, cantidad: 5 },
    ]);
    expect(propuesto).toBe(1064);
    expect(cobrado).toBeCloseTo(propuesto, 2);
  });

  it('agregar un producto que cruza el umbral (antes $854 vs $836)', async () => {
    // Ocho piezas + seis nuevas = 14: el agregado nace a mayoreo, y las líneas
    // que ya estaban también. La propuesta de ventas no aplicaba la promo al
    // agregado porque no tiene par congelado hasta que se aprueba.
    const items = [fila(1, { base: 65, mayoreo: 61.75, cantidad: 8 })];
    const { propuesto, cobrado } = await propuestoVsCobrado(
      items,
      [{ accion: 'AGREGAR', precioCOId: 9, cantidad: 6 }],
      [AGREGADO],
    );
    expect(propuesto).toBeCloseTo(8 * 61.75 + 6 * 57, 2);
    expect(cobrado).toBeCloseTo(propuesto, 2);
  });

  it('quitar baja el pedido de 13 a 3 piezas y la promo se REVOCA', async () => {
    const items = [
      fila(1, { base: 100, mayoreo: 80, cantidad: 10, precioUnitario: D(80), subtotal: D(800) }),
      fila(2, { base: 100, mayoreo: 80, cantidad: 3, precioUnitario: D(80), subtotal: D(240) }),
    ];
    const { propuesto, cobrado } = await propuestoVsCobrado(items, [
      { accion: 'QUITAR', itemId: 1 },
    ]);
    expect(propuesto).toBe(300);
    expect(cobrado).toBeCloseTo(300, 2);
  });

  it('bajar una cantidad por debajo del umbral', async () => {
    const items = [
      fila(1, { base: 100, mayoreo: 80, cantidad: 12, precioUnitario: D(80), subtotal: D(960) }),
    ];
    const { propuesto, cobrado } = await propuestoVsCobrado(items, [
      { accion: 'CANTIDAD', itemId: 1, cantidad: 10 },
    ]);
    expect(propuesto).toBe(1000);
    expect(cobrado).toBeCloseTo(1000, 2);
  });

  it('mezcla: sube una, baja otra, quita otra y agrega una', async () => {
    const items = [
      fila(1, { base: 100, mayoreo: 80, cantidad: 4 }),
      fila(2, { base: 100, mayoreo: 80, cantidad: 6 }),
      fila(3, { base: 100, mayoreo: 80, cantidad: 3 }),
    ];
    const { propuesto, cobrado } = await propuestoVsCobrado(
      items,
      [
        { accion: 'CANTIDAD', itemId: 1, cantidad: 9 },
        { accion: 'CANTIDAD', itemId: 2, cantidad: 2 },
        { accion: 'QUITAR', itemId: 3 },
        { accion: 'AGREGAR', precioCOId: 9, cantidad: 3 },
      ],
      [AGREGADO],
    );
    // 9 + 2 + 3 = 14 piezas → mayoreo para todas.
    expect(propuesto).toBeCloseTo(9 * 80 + 2 * 80 + 3 * 57, 2);
    expect(cobrado).toBeCloseTo(propuesto, 2);
  });
});

// =============================================================================
// El camino de BODEGA, contra el cobro real
// =============================================================================

describe('construirPropuestaDeBodega — el total coincide con el cobro', () => {
  function revisar(items: any[]): { propuesta: number; cobro: number } {
    const { total } = construirPropuestaDeBodega(items as never);
    return { propuesta: total, cobro: cobroReal(items) };
  }

  it('un producto agotado que baja el pedido de 12 a 10 (antes $800 vs $1000)', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1000);
    expect(propuesta).toBe(cobro);
  });

  it('un parcial que baja el pedido de 12 a 11 (antes $900 vs $1100)', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 1, EstadoSurtido.PARCIAL),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1100);
    expect(propuesta).toBe(cobro);
  });

  it('un item colapsado por bodega (20 pedidas, 10 hay)', () => {
    const items = [item(1, 20, 10, 10, EstadoSurtido.COMPLETO)];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(1000);
    expect(propuesta).toBe(cobro);
  });

  it('un parcial que CONSERVA las 12 piezas mantiene la promo', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 4, 4, 2, EstadoSurtido.PARCIAL),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(960);
    expect(propuesta).toBe(cobro);
  });

  it('16 pedidas que quedan en 14 conservan la promo', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 4, 4, 4, EstadoSurtido.COMPLETO),
      item(3, 2, 2, 0, EstadoSurtido.NO_DISPONIBLE),
    ];
    const { propuesta, cobro } = revisar(items);
    // 14 piezas siguen sobre el umbral: la promo se mantiene a $80.
    expect(propuesta).toBe(1120);
    expect(propuesta).toBe(cobro);
  });

  it('un pedido intacto de 12+ no cambia de precio', () => {
    const items = [
      item(1, 10, 10, 10, EstadoSurtido.COMPLETO),
      item(2, 2, 2, 2, EstadoSurtido.COMPLETO),
    ];
    const { propuesta, cobro } = revisar(items);
    expect(propuesta).toBe(960);
    expect(propuesta).toBe(cobro);
  });
});

// =============================================================================
// Fase 3b (oct 2026, decisión 3): REPONER una línea que bodega no encontró
// =============================================================================
//
// El dueño: "se puede reponer una línea que bodega marcó sin existencia". Reponer
// DESHACE la salida de esa línea (no crea una nueva): conserva el "Pediste N" y el
// par de precios congelado. Se describe en el snapshot como un `parcial` —"Pediste
// 5 · Hay 0 · Te llevas 3"— y el aplicador la reconoce por el estado de la línea en
// la BD, no por una marca del snapshot.

/** Una línea que bodega no encontró: lo que deja `datosDeFaltaDeBodega()`. */
function sinExistencia(id: number, over: Partial<Record<string, unknown>> = {}) {
  return fila(id, {
    cantidad: 5,
    cantidadPedida: 5,
    cancelada: true,
    estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
    cantidadSurtida: 0,
    ...over,
  });
}

describe('calcularAjuste — REPONER', () => {
  it('una línea sin existencia vuelve como un `parcial` con el hallazgo en 0', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 4 }), sinExistencia(2)],
      [{ accion: 'REPONER', itemId: 2, cantidad: 3 }],
    );

    const linea = r.items.find((l) => l.itemId === 2)!;
    expect(linea).toMatchObject({
      tipo: 'parcial',
      cantidadOriginal: 5, // lo que el cliente pidió: no se pierde
      cantidadDisponible: 0, // bodega no encontró nada: sigue siendo cierto
      cantidadNueva: 3,
      ajusteExplicito: true,
      piezasPorSurtir: 3, // todas sus piezas: nadie las ha visto
    });
    expect(r.hayCambios).toBe(true);
    // Antes de este ajuste la línea no estaba en el pedido: no suma a "lo que valía".
    expect(linea.subtotalOriginal).toBe(0);
    expect(linea.subtotal).toBe(0);
    expect(linea.subtotalNuevo).toBe(300);
  });

  it('suma al total y a las piezas por surtir; NO a lo que el pedido valía antes', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 4 }), sinExistencia(2)],
      [{ accion: 'REPONER', itemId: 2, cantidad: 3 }],
    );

    expect(r.total).toBe(4 * 100 + 3 * 100);
    expect(r.piezasFinales).toBe(7);
    expect(r.piezasPorSurtir).toBe(3);
    // La línea no se estaba cobrando: el pedido valía solo la otra.
    expect(r.totalAntes).toBe(400);
  });

  it('cuenta para la promo de volumen: las piezas repuestas pueden cruzar el umbral', () => {
    const r = calcularAjuste(
      [fila(1, { cantidad: 8 }), sinExistencia(2)],
      [{ accion: 'REPONER', itemId: 2, cantidad: 4 }],
    );

    // 8 + 4 = 12 piezas → mayoreo ($80) para todas, también para la línea que ya estaba.
    expect(r.total).toBeCloseTo(12 * 80, 2);
    // Y como esas 4 piezas nadie las ha visto, el mayoreo es condicional.
    expect(r.mayoreoCondicional).toBe(true);
  });

  it('la línea repuesta vuelve a su lugar en el orden del pedido', () => {
    const r = calcularAjuste(
      [fila(1), sinExistencia(2), fila(3)],
      [{ accion: 'REPONER', itemId: 2, cantidad: 2 }],
    );
    expect(r.items.map((l) => l.itemId)).toEqual([1, 2, 3]);
  });

  it('puede reponer MÁS de lo que se pidió al inicio (decisión del dueño)', () => {
    const r = calcularAjuste(
      [fila(1), sinExistencia(2)],
      [{ accion: 'REPONER', itemId: 2, cantidad: 9 }],
    );
    expect(r.items.find((l) => l.itemId === 2)).toMatchObject({
      cantidadOriginal: 5,
      cantidadNueva: 9,
    });
  });

  it('una línea sin existencia que nadie repone NO aparece en el snapshot', () => {
    const r = calcularAjuste(
      [fila(1), sinExistencia(2)],
      [{ accion: 'CANTIDAD', itemId: 1, cantidad: 7 }],
    );
    expect(r.items.map((l) => l.itemId)).toEqual([1]);
  });

  it.each([
    [
      'una línea viva (para eso es CANTIDAD)',
      [fila(1), sinExistencia(2)],
      { accion: 'REPONER' as const, itemId: 1, cantidad: 2 },
    ],
    [
      'una línea que alguien QUITÓ teniendo piezas apartadas (ya tiene trabajo en marcha)',
      [fila(1), fila(2, { cancelada: true, cantidadSurtida: 4 })],
      { accion: 'REPONER' as const, itemId: 2, cantidad: 2 },
    ],
    [
      'una línea cancelada que no es NO_DISPONIBLE (se cambió por otra)',
      [
        fila(1),
        fila(2, { cancelada: true, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE }),
      ],
      { accion: 'REPONER' as const, itemId: 2, cantidad: 2 },
    ],
    [
      'un item que no es del pedido',
      [fila(1)],
      { accion: 'REPONER' as const, itemId: 99, cantidad: 2 },
    ],
  ])('rechaza reponer %s', (_n, items, intencion) => {
    expect(() => calcularAjuste(items, [intencion])).toThrow(/no se puede reponer/);
  });

  it.each([0, 1.5, -1])('rechaza reponer con cantidad %s', (cantidad) => {
    expect(() =>
      calcularAjuste([fila(1), sinExistencia(2)], [{ accion: 'REPONER', itemId: 2, cantidad }]),
    ).toThrow(/al menos 1 pieza/);
  });

  it('rechaza dos cambios sobre la misma línea', () => {
    expect(() =>
      calcularAjuste(
        [fila(1), sinExistencia(2)],
        [
          { accion: 'REPONER', itemId: 2, cantidad: 2 },
          { accion: 'REPONER', itemId: 2, cantidad: 3 },
        ],
      ),
    ).toThrow(/dos cambios a la vez/);
  });
});

describe('calcularAjuste — REPONER contra el aplicador REAL', () => {
  const pedidoPlano = { id: 1, tiendaId: 5, descuento: D(0), impuestos: D(0) };

  it('el total propuesto es el que se cobra, y la línea vuelve PENDIENTE sin tocar lo pedido', async () => {
    const items = [
      fila(1, { base: 100, mayoreo: 80, cantidad: 8 }),
      sinExistencia(2, { base: 100, mayoreo: 80 }),
    ];
    const calculo = calcularAjuste(items, [{ accion: 'REPONER', itemId: 2, cantidad: 4 }]);
    const bd = bdEnMemoria(items);

    const r = await aplicarPropuestaDeVentas(
      bd.tx as never,
      pedidoPlano,
      calculo.items as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    // 8 + 4 = 12 piezas: la promo entra para todas y el cobro coincide con la propuesta.
    expect(calculo.total).toBeCloseTo(12 * 80, 2);
    expect(bd.cobrado()).toBeCloseTo(calculo.total, 2);
    // La línea volvió como cualquier línea que nadie ha visto: bodega la verifica.
    const repuesta = (await bd.tx.itemPedido.findUnique({ where: { id: 2 } })) as any;
    expect(repuesta).toMatchObject({
      cancelada: false,
      cantidad: 4,
      cantidadPedida: 5, // lo que el cliente pidió no se toca
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 0,
      piezasRetiradas: 0,
    });
    // Y por eso el pedido tiene que pasar por bodega.
    expect(r.quedanPendientes).toBe(true);
  });

  it('un `parcial` viejo sobre una línea que NO está sin existencia no la resucita', async () => {
    // Una línea cancelada porque el cliente la quitó (conserva piezas apartadas):
    // un snapshot que la mencione como `parcial` no puede devolverla al pedido.
    const retirada = fila(2, { cancelada: true, cantidadSurtida: 4, cantidad: 4 });
    const items = [fila(1, { cantidad: 4 }), retirada];
    const bd = bdEnMemoria(items);
    const snapshot = [
      { itemId: 2, tipo: 'parcial', cantidad: 4, cantidadNueva: 3, producto: 'P2' },
    ];

    await aplicarPropuestaDeVentas(
      bd.tx as never,
      pedidoPlano,
      snapshot as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    const tras = (await bd.tx.itemPedido.findUnique({ where: { id: 2 } })) as any;
    expect(tras.cancelada).toBe(true);
  });
});
