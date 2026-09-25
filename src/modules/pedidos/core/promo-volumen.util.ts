import { Prisma } from '@prisma/client';
import {
  PIEZAS_MAYOREO,
  precioConPromoVolumen,
} from '../../precios/precio-lista.util';

/**
 * Promo de volumen (sep 2026): re-evaluación del precio efectivo de un pedido.
 *
 * Regla: si el pedido lleva 12+ piezas (mezclando productos, colores y tallas
 * libremente), cada pieza vale `min(precio base, precio mayoreo)`. Por debajo
 * del umbral vale su precio base.
 *
 * Delega en `precioConPromoVolumen` — la MISMA función que usan la creación del
 * pedido y el endpoint del carrito. Tenerla en un solo lugar es lo que hace que
 * el precio congelado al crear sea punto fijo de esta re-evaluación: si aquí
 * hubiera un gate distinto (p. ej. "¿el cliente es de lista1?"), un pedido
 * podría cambiar de precio solo, sin que nadie lo edite.
 *
 * Opera sobre el par congelado en el item (`precioUnitarioBase` /
 * `precioUnitarioMayoreo`), NO sobre `PrecioCO`. Eso es deliberado: el precio
 * de la variante pudo cambiar en Firebird mientras el pedido estaba en bodega,
 * y `precioCOId` puede haberse borrado. El pedido se re-cotiza contra los
 * precios que congeló, no contra los de hoy.
 *
 * Es IDEMPOTENTE: dado el par congelado y el conteo actual, el resultado es
 * siempre el mismo. Correrlo dos veces no acumula descuento ni lo pierde.
 *
 * Los items con `precioUnitarioBase` en NULL son de pedidos anteriores a la
 * promo; si CUALQUIERA de los items lo tiene, no se toca nada — un pedido a
 * medio migrar no debe quedar con dos precios distintos entre sus líneas.
 */
export async function aplicarPromoVolumen(
  tx: Prisma.TransactionClient,
  pedidoId: number,
): Promise<{ totalPiezas: number; aplica: boolean }> {
  const items = await tx.itemPedido.findMany({
    where: { pedidoId, cancelada: false },
    select: {
      id: true,
      cantidad: true,
      precioUnitario: true,
      precioUnitarioBase: true,
      precioUnitarioMayoreo: true,
    },
  });

  const totalPiezas = items.reduce((acc, i) => acc + i.cantidad, 0);

  // Pedido anterior a la promo (o sin items): no hay par congelado que aplicar.
  // `== null` cubre `undefined` además de `null` — Prisma siempre devuelve la
  // columna, pero un caller que construya el item a mano (tests, mocks) puede
  // omitirla, y omitirla significa lo mismo que no tenerla.
  const sinParCongelado = items.some((i) => i.precioUnitarioBase == null);
  if (sinParCongelado) return { totalPiezas, aplica: false };

  const aplica = totalPiezas >= PIEZAS_MAYOREO;

  for (const item of items) {
    const base = new Prisma.Decimal(item.precioUnitarioBase!);
    const mayoreo = new Prisma.Decimal(item.precioUnitarioMayoreo ?? base);
    const objetivo = precioConPromoVolumen(base, mayoreo, totalPiezas);

    if (!objetivo.equals(item.precioUnitario)) {
      await tx.itemPedido.update({
        where: { id: item.id },
        data: {
          precioUnitario: objetivo,
          subtotal: objetivo.mul(item.cantidad),
        },
      });
    }
  }

  return { totalPiezas, aplica };
}
