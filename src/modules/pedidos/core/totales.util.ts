import { Prisma } from '@prisma/client';
import { aplicarPromoVolumen } from './promo-volumen.util';

/**
 * F16 (sep 2026): recálculo de los totales de un pedido.
 *
 * Vivía privado en `PropuestaService` y `MostradorService` lo necesitaba para
 * el ajuste tipo POS. Extraído aquí para que los dos caminos usen la MISMA
 * fórmula — si divergieran, un pedido ajustado en mostrador podría quedar con
 * un total distinto al que calcularía una propuesta con los mismos items.
 *
 * Reglas:
 *   - Solo cuentan los items NO cancelados.
 *   - `subtotal` = suma de los subtotales de los items.
 *   - `total`    = subtotal − descuento + impuestos.
 *
 * Se opera con `Decimal` (no `number`) para no introducir error de punto
 * flotante en el dinero: 0.1 + 0.2 debe ser 0.3, no 0.30000000000000004.
 *
 * sep 2026 — promo de volumen: antes de sumar, se re-evalúa el precio efectivo
 * de cada item (`aplicarPromoVolumen`). Esto convierte a esta función en el
 * ÚNICO punto donde la promo se aplica o se revoca, y es a propósito: los
 * cuatro caminos que mutan items de un pedido ya la llaman
 * (`MostradorService.aplicarAjuste`, `PropuestaService` en sus dos ramas y
 * `SurtidoService.aplicarCambiosSurtido`), así que colgarla aquí garantiza que
 * ninguno —ni uno futuro— pueda olvidarla. Un pedido que baja de 12 piezas
 * porque bodega no encontró mercancía pierde la promo; uno que sube a 12
 * porque el mostrador agregó productos la gana, en ambos casos sin código
 * adicional en esos caminos.
 */
export async function recalcularTotalesPedido(
  tx: Prisma.TransactionClient,
  pedido: { id: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
): Promise<{ subtotal: Prisma.Decimal; total: Prisma.Decimal }> {
  await aplicarPromoVolumen(tx, pedido.id);

  const items = await tx.itemPedido.findMany({
    where: { pedidoId: pedido.id, cancelada: false },
    select: { subtotal: true },
  });

  const subtotal = items.reduce(
    (acc, i) => acc.plus(new Prisma.Decimal(i.subtotal)),
    new Prisma.Decimal(0),
  );
  const total = subtotal
    .minus(new Prisma.Decimal(pedido.descuento))
    .plus(new Prisma.Decimal(pedido.impuestos));

  await tx.pedido.update({
    where: { id: pedido.id },
    data: { subtotal, total },
  });

  return { subtotal, total };
}
