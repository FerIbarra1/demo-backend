import { Prisma } from '@prisma/client';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';

/**
 * F20 (oct 2026): el total de una propuesta, calculado con la MISMA regla que
 * el cobro.
 *
 * El bug que esto arregla (dos variantes del mismo error):
 *
 *   1. El total sumaba `subtotal` de las líneas que la propuesta QUITA. Un
 *      `no-disponible` trae el subtotal de la cantidad PEDIDA, así que sumaba:
 *      en un pedido de $1000 con un producto agotado de $300, la propuesta
 *      decía **$1300** y se cobraban $1000.
 *
 *   2. El precio de una línea se tomaba CONGELADO en el item, pero el cobro lo
 *      RE-EVALÚA (`aplicarPromoVolumen`). La promo de volumen (12+ piezas →
 *      lista 2) se revoca cuando el pedido baja del umbral: un pedido de 12
 *      piezas que la propuesta deja en 10 mostraba $800 y se cobraban $1000.
 *
 * Los dos son el mismo error de fondo: **mostrar un número que no sale de la
 * función que cobra**. Aquí se arregla de raíz — el total se calcula con
 * `precioConPromoVolumen`, la MISMA función que usan la creación del pedido, el
 * carrito y la re-evaluación, y con el conteo de piezas FINAL del pedido.
 *
 * Por eso este util vive en `core/` y lo comparten el camino de BODEGA
 * (`construirPropuestaDeBodega`) y el de VENTAS (`PropuestaService`): mientras
 * los dos llamen aquí, no pueden divergir.
 */

/**
 * Una línea del pedido TAL COMO QUEDARÍA después de aplicar la propuesta.
 *
 * `cantidad` es la cantidad FINAL (0 = la línea sale del pedido y no se cobra).
 * El par `base`/`mayoreo` es el congelado en el item, que es lo que permite
 * re-evaluar la promo sin releer `PrecioCO` — y sin depender de la lista del
 * cliente, que puede haber cambiado desde que se creó el pedido.
 */
export interface LineaFinal {
  /** Piezas que quedan en la línea tras la propuesta. 0 = sale. */
  cantidad: number;
  /**
   * Precio base congelado (el de la lista del cliente). `null` en pedidos
   * anteriores a la promo de sep 2026: ahí no hay par que re-evaluar y se usa
   * `precioUnitario`.
   */
  base: Prisma.Decimal | number | string | null;
  /** Precio de lista 2 congelado. */
  mayoreo: Prisma.Decimal | number | string | null;
  /** Precio de respaldo cuando no hay par congelado. */
  precioUnitario: Prisma.Decimal | number | string;
}

/**
 * Total de la propuesta: suma SOLO lo que sobrevive, al precio que se cobrará.
 *
 * Dos pasadas a propósito (igual que `evaluarPromoVolumen` del carrito): la
 * promo se decide con el total de piezas FINAL, no con el acumulado parcial.
 * Resolverlo en una sola pasada daría precios mezclados — las primeras líneas a
 * base y las últimas a mayoreo — según el orden en que llegaran.
 */
export function totalDePropuesta(lineas: LineaFinal[]): number {
  const totalPiezas = lineas.reduce((acc, l) => acc + Math.max(0, l.cantidad), 0);

  return lineas.reduce((acc, l) => {
    if (l.cantidad <= 0) return acc;

    const base = l.base;
    const precio =
      base == null
        ? Number(l.precioUnitario)
        : Number(
            precioConPromoVolumen(
              new Prisma.Decimal(base),
              new Prisma.Decimal(l.mayoreo ?? base),
              totalPiezas,
            ),
          );

    return acc + precio * l.cantidad;
  }, 0);
}

/**
 * ¿Esta línea de la propuesta sigue en el pedido?
 *
 * `no-disponible` es el único tipo que saca una línea sin reemplazo. El nombre
 * es herencia del modelo viejo: significa "esta línea ya no va", no "no hay
 * mercancía" (ver `cancelacion-linea.util.ts`).
 *
 * `cambio` SÍ sobrevive: reemplaza el original por otro producto, y el nuevo
 * viaja como su propia línea (`cantidadNueva`).
 */
export function lineaSobrevive(tipo: string): boolean {
  return tipo !== 'no-disponible';
}
