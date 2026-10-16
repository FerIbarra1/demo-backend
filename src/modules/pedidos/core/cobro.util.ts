import { EstadoPedido } from '@prisma/client';

/**
 * Estados en los que el pedido YA pasó por el cobro.
 *
 * `PAGADO` es el cobro en sí; `ENVIADO` y `ENTREGADO` vienen después y solo son
 * alcanzables desde un pedido pagado (`TRANSICIONES[PAGADO]`).
 *
 * Oct 2026 — por qué existe: el trigger `TRG_PEDIDOS_SYNC` de Firebird dispara con
 * CUALQUIER cambio de `FINALIZADA`, `TTOTAL`, `NOTAS`, `SERIEFAC` o `IDFACTURA`, y el
 * agente sube la fila completa. O sea: si se edita `NOTAS` o se asigna/cambia el
 * `IDFACTURA` de un pedido ya cobrado, llega un evento con `FINALIZADA = true` otra vez.
 * El handler solo trataba como "ya pagado" a `PAGADO`, así que:
 *   - un pedido `ENVIADO` retrocedía a `PAGADO` (y le volvía a salir el correo
 *     "pago confirmado"), y
 *   - uno `ENTREGADO` fallaba, se reintentaba 5 veces y terminaba en DEAD_LETTER.
 */
export const ESTADOS_YA_COBRADOS: readonly EstadoPedido[] = [
  EstadoPedido.PAGADO,
  EstadoPedido.ENVIADO,
  EstadoPedido.ENTREGADO,
];

export function yaFueCobrado(estado: EstadoPedido): boolean {
  return ESTADOS_YA_COBRADOS.includes(estado);
}
