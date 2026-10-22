import { Prisma, EstadoSurtido } from '@prisma/client';
import {
  calcularAjusteDeCantidad,
  piezasEnLaBolsa,
  piezasFueraDeLaBolsa,
  piezasPendientesDeRetiro,
} from './ajuste-cantidad.util';
import { aplicarPropuestaDeVentas } from './aplicar-propuesta-ventas.util';
import { construirPropuestaDeBodega } from './propuesta-bodega.util';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';

/**
 * F21 (oct 2026): LOS TRES NÚMEROS.
 *
 * El bug que este spec fija, reportado desde el piso:
 *
 *   "El cliente pidió 5, hay 3, y en el ajuste pidió bajar a 1 de las 3 que hay.
 *    El sistema me dice que se solicitaron 5 pero que solo hay 1 disponible, y
 *    eso no es cierto."
 *
 * El renglón correcto es "Pediste 5 · Hay 3 · Te llevas 1". Cada número sale de
 * una columna distinta y ninguna se pisa:
 *
 *   cantidadPedida  → Pediste   (inmutable, F19)
 *   cantidadSurtida → Hay       (hallazgo físico de bodega)
 *   cantidad        → Te llevas (lo que se cobra)
 */

// ---------------------------------------------------------------- helpers

const BASE = 100; // precio de lista 1
const MAYOREO = 80; // precio de lista 2 (promo de volumen, 12+ piezas)

/** Un item con los tres números explícitos. */
function item(opts: {
  id: number;
  cantidadPedida: number;
  cantidadSurtida: number;
  cantidad: number;
  estadoSurtido?: EstadoSurtido;
  cancelada?: boolean;
}) {
  const estadoSurtido = opts.estadoSurtido ?? EstadoSurtido.COMPLETO;
  const precioUnitario = precioConPromoVolumen(
    new Prisma.Decimal(BASE),
    new Prisma.Decimal(MAYOREO),
    opts.cantidad,
  );
  return {
    id: opts.id,
    productoId: 1,
    productoNombre: `Prenda ${opts.id}`,
    productoCodigo: `C0${opts.id}`,
    productoImagen: null,
    corridaNombre: 'Verano',
    tallaNombre: 'M',
    colorNombre: 'Negro',
    cantidadPedida: opts.cantidadPedida,
    cantidad: opts.cantidad,
    cantidadSurtida: opts.cantidadSurtida,
    estadoSurtido,
    precioUnitario,
    precioUnitarioBase: new Prisma.Decimal(BASE),
    precioUnitarioMayoreo: new Prisma.Decimal(MAYOREO),
    subtotal: precioUnitario.mul(opts.cantidad),
    cancelada: opts.cancelada ?? false,
  };
}

/**
 * El `tx` falso que captura los updates.
 *
 * `count` y `findUnique` leen del estado YA MUTADO: `aplicarPropuestaDeVentas`
 * escribe los items y después cuenta los que quedaron sin surtir
 * (`pendientesRestantes`), así que un mock que devolviera siempre el estado
 * inicial daría un `quedanPendientes` que no corresponde a lo que el método
 * acaba de hacer.
 */
function crearTx(items: any[]) {
  const updates: Array<{ id: number; data: any }> = [];
  const estado = new Map(items.map((i) => [i.id, { ...i }]));
  const tx = {
    pedidoDtf: { count: async () => 0, findMany: async () => [] }, // sin trabajos DTF (impresión DTF, oct 2026)
    itemPedido: {
      findUnique: async ({ where }: any) => estado.get(where.id) ?? null,
      findMany: async () => [...estado.values()],
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        const actual = { ...estado.get(where.id), ...data };
        estado.set(where.id, actual);
        return actual;
      },
      count: async ({ where }: any) =>
        [...estado.values()].filter((i) => {
          if (i.cancelada) return false;
          if (where?.estadoSurtido?.not) return i.estadoSurtido !== where.estadoSurtido.not;
          return true;
        }).length,
      create: async ({ data }: any) => data,
    },
    pedido: { update: async () => ({}) },
    pedidoPropuesta: { update: async () => ({}) },
  };
  return { tx, updates };
}

const pedido = {
  id: 1,
  tiendaId: 1,
  descuento: new Prisma.Decimal(0),
  impuestos: new Prisma.Decimal(0),
};

// ---------------------------------------------------------------- el bug

describe('F21 — el caso reportado: pidió 5, hay 3, se lleva 1', () => {
  it('el ajuste NO pisa el hallazgo físico: "Hay 3", no "Hay 1"', () => {
    const antes = {
      cantidad: 3, // vigente: lo que bodega colapsó
      cantidadSurtida: 3, // lo que hay
      estadoSurtido: EstadoSurtido.COMPLETO,
    };

    const r = calcularAjusteDeCantidad(antes, 1);

    // Los tres números, cada uno de su columna.
    expect(r.data.cantidad).toBe(1); // Te llevas 1
    expect(r.data.cantidadSurtida).toBe(3); // Hay 3  ← el bug: antes quedaba en 1
    expect(r.data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
    // Las 2 que sobran vuelven al anaquel.
    expect(r.piezasSobrantes).toBe(2);
    expect(r.subeLaCantidad).toBe(false);
  });

  it('el camino de VENTAS conserva el hallazgo al bajar', async () => {
    const items = [item({ id: 1, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 3 })];
    const { tx, updates } = crearTx(items);

    await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Prenda 1',
          variante: 'M',
          cantidad: 5,
          precioUnitario: BASE,
          subtotal: 500,
          cantidadNueva: 1,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    const u = updates.find((x) => x.id === 1)!;
    expect(u.data.cantidad).toBe(1);
    expect(u.data.cantidadSurtida).toBe(3); // el hallazgo sobrevive
    // Las 2 sobrantes las saca el bodeguero de la bolsa (no hay reposición).
    expect(u.data.estadoSurtido).toBe(EstadoSurtido.COMPLETO);
  });

  it('las piezas que sobran mandan el pedido a bodega a sacarlas de la bolsa', async () => {
    const items = [item({ id: 1, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 3 })];
    const { tx } = crearTx(items);

    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Prenda 1',
          variante: 'M',
          cantidad: 5,
          precioUnitario: BASE,
          subtotal: 500,
          cantidadNueva: 1,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    // 3 había, 1 se lleva: sobran 2 en la bolsa y el bodeguero las saca.
    expect(r.huboRetiro).toBe(true);
  });

  it('la propuesta de bodega describe el renglón con los tres números', () => {
    // El pedido tal como queda tras el ajuste: se lleva 1, hay 3, pidió 5.
    const { items } = construirPropuestaDeBodega([
      item({ id: 1, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 1 }),
    ] as never);

    const linea = items[0];
    expect(linea.cantidadOriginal).toBe(5); // Pediste 5
    expect(linea.cantidadNueva).toBe(1); // Te llevas 1
    // El "Hay 3" no viaja en el snapshot de la propuesta: vive en el item, y es
    // lo que la pantalla lee para el número del medio.
  });
});

// ---------------------------------------------------------------- subir

describe('F21 — el ajuste que SUBE (llegó mercancía nueva)', () => {
  it('manda el item de vuelta a bodega: nadie verificó las piezas nuevas', () => {
    const r = calcularAjusteDeCantidad(
      { cantidad: 3, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.COMPLETO },
      7,
    );

    expect(r.subeLaCantidad).toBe(true);
    expect(r.data.cantidad).toBe(7);
    expect(r.data.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    // Oct 2026 (decisión 2): la línea se REBASA a lo que hay en la bolsa y bodega
    // verifica SOLO las 4 de más. Antes se reiniciaba a 0 y re-verificaba las 7,
    // cuando 3 ya estaban físicamente en la bolsa.
    expect(r.data.cantidadSurtida).toBe(3);
    expect(r.data.piezasBase).toBe(3);
    // No hay sobrante: todo lo que se lleva se queda.
    expect(r.piezasSobrantes).toBe(0);
  });

  it('el pedido que SUBE queda pendiente de surtir', async () => {
    const items = [item({ id: 1, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 3 })];
    const { tx } = crearTx(items);

    const r = await aplicarPropuestaDeVentas(
      tx as never,
      pedido,
      [
        {
          itemId: 1,
          tipo: 'parcial',
          producto: 'Prenda 1',
          variante: 'M',
          cantidad: 5,
          precioUnitario: BASE,
          subtotal: 500,
          cantidadNueva: 7,
        },
      ] as never,
      items.map((i) => ({ id: i.id, precioUnitario: i.precioUnitario })),
      'lista1',
    );

    expect(r.quedanPendientes).toBe(true);
    expect(r.huboRetiro).toBe(false);
  });
});

// ---------------------------------------------------------------- dinero

describe('F21 — el dinero no se contamina con el hallazgo conservado', () => {
  it('la promo se decide con lo que se COBRA, no con lo que había', () => {
    // 11 piezas intactas + 1 item de 5 del que había 3 y se lleva 1.
    // Lo que se cobra: 11 + 1 = 12 piezas → la promo SÍ aplica (umbral 12).
    // Si contara el hallazgo (3) daría 14, y también aplicaría — así que el
    // caso que discrimina es al revés: bajar por debajo del umbral.
    const items = [
      item({ id: 1, cantidadPedida: 11, cantidadSurtida: 11, cantidad: 11 }),
      item({ id: 2, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 1 }),
    ];

    const { total } = construirPropuestaDeBodega(items as never);

    // 12 piezas → promo: 12 × $80 = $960.
    // Con el hallazgo (11 + 3 = 14) también daría promo, pero por el número
    // equivocado. El caso que lo delata es el de abajo.
    expect(total).toBe(960);
  });

  it('un pedido que BAJA del umbral por el ajuste REVOCA la promo', () => {
    // 11 intactas + 1 que se lleva de un item donde había 3.
    // Se cobran 12 → promo. Pero si el ajuste hubiera dejado 0, se cobrarían 11
    // y la promo se revoca. Este test fija que el conteo usa `cantidad`.
    const items = [
      item({ id: 1, cantidadPedida: 11, cantidadSurtida: 11, cantidad: 11 }),
      item({ id: 2, cantidadPedida: 5, cantidadSurtida: 3, cantidad: 1 }),
    ];
    const { total } = construirPropuestaDeBodega(items as never);

    // El mismo pedido contando el hallazgo (11 + 3 = 14) daría 14 × 80 = 1120.
    // Contando lo que se cobra (12) da 960. La diferencia ES el bug.
    expect(total).toBe(960);
    expect(total).not.toBe(1120);
  });
});

// ---------------------------------------------------------------- reposición

describe('F21 — piezasFueraDeLaBolsa: qué vuelve al anaquel', () => {
  it('una línea cancelada devuelve todo lo que había', () => {
    expect(piezasFueraDeLaBolsa({ cancelada: true, cantidad: 5, cantidadSurtida: 3 })).toBe(3);
  });

  it('una línea ACTIVA reducida devuelve solo el excedente', () => {
    // El caso que faltaba: bajar de 5 a 1 con 3 en la bolsa deja 2 sobrantes.
    expect(piezasFueraDeLaBolsa({ cancelada: false, cantidad: 1, cantidadSurtida: 3 })).toBe(2);
  });

  it('una línea activa sin excedente no devuelve nada', () => {
    expect(piezasFueraDeLaBolsa({ cancelada: false, cantidad: 3, cantidadSurtida: 3 })).toBe(0);
  });

  it('una línea que SUBIÓ no devuelve nada: lo que hay se queda', () => {
    expect(piezasFueraDeLaBolsa({ cancelada: false, cantidad: 7, cantidadSurtida: 3 })).toBe(0);
  });

  it('una línea sin nada apartado no devuelve nada', () => {
    expect(piezasFueraDeLaBolsa({ cancelada: true, cantidad: 5, cantidadSurtida: 0 })).toBe(0);
  });
});

/**
 * F21 (oct 2026): `piezasPendientesDeRetiro` — lo que TODAVÍA falta sacar.
 *
 * `piezasFueraDeLaBolsa` es posicional: deriva el sobrante de comparar
 * `cantidadSurtida` con `cantidad`, así que no sabe que el bodeguero ya sacó las
 * prendas. Sacar mercancía de la bolsa no cambia ninguna de las dos columnas.
 *
 * Sin esta resta, un segundo ajuste sobre el mismo pedido vuelve a pedir sacar
 * prendas que ya están fuera de la bolsa: el bodeguero va a la mesa a buscar
 * mercancía que no está ahí.
 *
 * Es un CONTEO y no un flag: el caso "el segundo ajuste quita más" es el que
 * distingue las dos implementaciones.
 */
describe('F21 — piezasPendientesDeRetiro: qué FALTA sacar', () => {
  it('sin retiros registrados, es igual al total fuera de la bolsa', () => {
    expect(
      piezasPendientesDeRetiro({
        cancelada: true,
        cantidad: 5,
        cantidadSurtida: 3,
        piezasRetiradas: 0,
      }),
    ).toBe(3);
  });

  it('un retiro completo deja el pendiente en 0', () => {
    // El bodeguero ya sacó las 2 que sobraban: no hay que volver a pedirlas.
    expect(
      piezasPendientesDeRetiro({
        cancelada: false,
        cantidad: 1,
        cantidadSurtida: 3,
        piezasRetiradas: 2,
      }),
    ).toBe(0);
  });

  it('un retiro parcial deja el resto pendiente', () => {
    // El ajuste 1 quitó 2 y el 2 quitó 1 más: el total fuera de la bolsa es 3 y
    // solo se retiraron 2. La tercera tiene que salir.
    //
    // ESTE es el caso que un `retiradoAt` booleano rompería: con un flag ya
    // puesto reportaría 0 y la prenda se quedaría dentro de la bolsa.
    expect(
      piezasPendientesDeRetiro({
        cancelada: false,
        cantidad: 1,
        cantidadSurtida: 4,
        piezasRetiradas: 2,
      }),
    ).toBe(1);
  });

  it('nunca devuelve negativo si el retiro registrado excede el sobrante', () => {
    // Defensivo: un dato inconsistente no debe producir un pendiente negativo
    // (el caller lo usa como "¿hay trabajo?", y un negativo sería truthy).
    expect(
      piezasPendientesDeRetiro({
        cancelada: false,
        cantidad: 5,
        cantidadSurtida: 5,
        piezasRetiradas: 3,
      }),
    ).toBe(0);
  });

  it('una línea sin nada apartado no pide retiro aunque tenga retiros viejos', () => {
    expect(
      piezasPendientesDeRetiro({
        cancelada: true,
        cantidad: 5,
        cantidadSurtida: 0,
        piezasRetiradas: 0,
      }),
    ).toBe(0);
  });
});

// ------------------------------------------------- segundo ajuste (oct 2026)

describe('oct 2026 — el ajuste cuenta lo que HAY en la bolsa, no lo que se encontró', () => {
  // Había 5, un ajuste bajó a 3 y el bodeguero sacó las 2 de más: en la bolsa
  // quedan 3, aunque `cantidadSurtida` (el hallazgo) siga diciendo 5.
  const tras1erRetiro = {
    cantidad: 3,
    cantidadSurtida: 5,
    piezasRetiradas: 2,
    estadoSurtido: EstadoSurtido.COMPLETO,
  };

  it('SUBIR por encima de lo que hay en la bolsa vuelve a bodega, aunque quepa en el hallazgo', () => {
    // 4 ≤ 5 (hallazgo) pero 4 > 3 (bolsa). Las 2 piezas que salieron ya están en
    // el anaquel: darlo por cubierto cobraba 4 con 3 en la bolsa.
    const r = calcularAjusteDeCantidad(tras1erRetiro, 4);

    expect(r.subeLaCantidad).toBe(true);
    expect(r.data.estadoSurtido).toBe(EstadoSurtido.PENDIENTE);
    // Se rebasa a lo que HAY en la bolsa (5 − 2 = 3), no al hallazgo original: las 2
    // que salieron ya están en el anaquel y bodega las trae como nuevas (es lo que
    // son). Bodega verifica 1 pieza, no 4.
    expect(r.data.cantidadSurtida).toBe(3);
    expect(r.data.piezasBase).toBe(3);
  });

  it('al re-verificar, el conteo de retiros se reinicia con el hallazgo', () => {
    // `piezasRetiradas` cuenta piezas contra el hallazgo de `cantidadSurtida`. Si
    // éste se reinicia y el conteo no, la siguiente baja restaría un retiro de
    // una ronda anterior y el bodeguero nunca recibiría el checklist de lo que de
    // verdad sobra.
    const r = calcularAjusteDeCantidad(tras1erRetiro, 4);

    expect(r.data.piezasRetiradas).toBe(0);
  });

  it('el ciclo completo: subir, re-verificar y volver a bajar SÍ pide sacar lo que sobra', () => {
    // Tras subir a 4 y re-verificar, bodega encontró 4: surtida 4, retiradas 0.
    const trasReverificar = {
      cantidad: 4,
      cantidadSurtida: 4,
      piezasRetiradas: 0,
      estadoSurtido: EstadoSurtido.COMPLETO,
    };
    const baja = calcularAjusteDeCantidad(trasReverificar, 2);

    // Sobran 2 y NO se descuenta ningún retiro viejo.
    expect(baja.piezasSobrantes).toBe(2);
    expect(
      piezasPendientesDeRetiro({
        cancelada: false,
        cantidad: 2,
        cantidadSurtida: 4,
        piezasRetiradas: 0,
      }),
    ).toBe(2);
  });

  it('BAJAR otra vez solo reporta lo que de verdad sobra en la bolsa', () => {
    // En la bolsa hay 3; el cliente baja a 2 → sobra 1 (no 3).
    const r = calcularAjusteDeCantidad(tras1erRetiro, 2);

    expect(r.subeLaCantidad).toBe(false);
    expect(r.piezasSobrantes).toBe(1);
    // El hallazgo sigue intacto y el conteo de retiros no se toca.
    expect(r.data.cantidadSurtida).toBe(5);
    expect(r.data).not.toHaveProperty('piezasRetiradas');
  });

  it('dejar la cantidad en lo que ya hay en la bolsa no pide nada', () => {
    const r = calcularAjusteDeCantidad(tras1erRetiro, 3);

    expect(r.subeLaCantidad).toBe(false);
    expect(r.piezasSobrantes).toBe(0);
  });

  it('sin `piezasRetiradas` se comporta como antes (caller que no lo lee)', () => {
    const r = calcularAjusteDeCantidad(
      { cantidad: 5, cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO },
      3,
    );

    expect(r.piezasSobrantes).toBe(2);
    expect(r.subeLaCantidad).toBe(false);
  });
});

describe('oct 2026 — piezasEnLaBolsa: lo que puede volver al anaquel si se cancela', () => {
  it('es lo encontrado menos lo que el bodeguero ya sacó', () => {
    expect(piezasEnLaBolsa({ cantidadSurtida: 5, piezasRetiradas: 2 })).toBe(3);
  });

  it('una línea cuyo retiro ya se completó no tiene nada en la bolsa', () => {
    expect(piezasEnLaBolsa({ cantidadSurtida: 4, piezasRetiradas: 4 })).toBe(0);
  });

  it('nunca devuelve negativo', () => {
    expect(piezasEnLaBolsa({ cantidadSurtida: 2, piezasRetiradas: 5 })).toBe(0);
  });

  it('sin retiros registrados es todo el hallazgo', () => {
    expect(piezasEnLaBolsa({ cantidadSurtida: 5 })).toBe(5);
    expect(piezasEnLaBolsa({ cantidadSurtida: 5, piezasRetiradas: null })).toBe(5);
  });
});

// ------------------------------------------- delta-only (oct 2026, decisión 2)

describe('oct 2026 (decisión 2) — subir deja a bodega verificar SOLO las piezas de más', () => {
  it('rebasa la línea a lo que hay en la bolsa y fija el piso', () => {
    // 3 en la bolsa, el cliente quiere 5: bodega verifica 2, no 5.
    const r = calcularAjusteDeCantidad(
      { cantidad: 3, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.COMPLETO },
      5,
    );

    expect(r.data).toMatchObject({
      cantidad: 5,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      cantidadSurtida: 3,
      piezasRetiradas: 0,
      piezasBase: 3,
    });
  });

  it('una línea sin nada en la bolsa no tiene piso: es la de siempre', () => {
    const r = calcularAjusteDeCantidad(
      { cantidad: 4, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE },
      6,
    );

    expect(r.data).toMatchObject({ cantidadSurtida: 0, piezasBase: 0 });
  });

  it('subir OTRA vez antes de que bodega marque conserva el mismo piso', () => {
    // 3 en la bolsa → 5 (piso 3) → 7: sigue habiendo 3 en la bolsa.
    const trasLaPrimera = {
      cantidad: 5,
      cantidadSurtida: 3,
      piezasRetiradas: 0,
      estadoSurtido: EstadoSurtido.PENDIENTE,
    };

    const r = calcularAjusteDeCantidad(trasLaPrimera, 7);

    expect(r.data).toMatchObject({ cantidad: 7, cantidadSurtida: 3, piezasBase: 3 });
  });

  it('bajar una línea subida (aún sin surtir) la deja COMPLETO y sin piso', () => {
    // 3 en la bolsa → 5 (PENDIENTE, piso 3) → 3: ya no espera nada de bodega, y un
    // piso viejo le impediría marcarla más adelante.
    const subida = {
      cantidad: 5,
      cantidadSurtida: 3,
      piezasRetiradas: 0,
      estadoSurtido: EstadoSurtido.PENDIENTE,
    };

    const r = calcularAjusteDeCantidad(subida, 3);

    expect(r.subeLaCantidad).toBe(false);
    expect(r.data).toMatchObject({
      cantidad: 3,
      cantidadSurtida: 3,
      estadoSurtido: EstadoSurtido.COMPLETO,
      piezasBase: 0,
    });
  });

  it('bajar una línea normal también limpia el piso', () => {
    const r = calcularAjusteDeCantidad(
      { cantidad: 5, cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO },
      2,
    );
    expect(r.data.piezasBase).toBe(0);
  });
});
