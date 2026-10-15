import { CanalOrigen, EstadoPedido, Prisma } from '@prisma/client';

/**
 * F22 (oct 2026): "¿el cliente de este pedido está físicamente en la tienda?" —
 * UNA sola respuesta para la cola, la consola, la TV, `llamarSiguiente`, bodega
 * (destino del surtido incompleto) y mostrador.
 *
 * Antes cada sitio armaba su propio predicado (`canalOrigen KIOSKO OR (WEB AND
 * aviso AND no descartado)`) y los dos mundos divergían en lo importante:
 *
 *   - Un pedido de KIOSKO era "presente SIEMPRE", así que el operador no tenía
 *     forma de sacar de la cola al cliente que ya se había ido: descartar exigía
 *     `llegadaAnunciadaAt`, que un kiosko nunca tiene.
 *   - El orden ponía todo web-con-aviso delante de cualquier kiosko.
 *
 * Regla:
 *
 *   KIOSKO → presente, salvo que el operador lo haya descartado.
 *   WEB    → presente si avisó llegada y el aviso no fue descartado.
 *
 * `llegadaDescartadaAt` es la ÚNICA marca de "ya no está" para los dos canales.
 */

/** Estados donde la bolsa está en el área de entrega esperando al cliente. */
export const ESTADOS_ESPERA_CLIENTE: EstadoPedido[] = [
  EstadoPedido.REVISADO,
  EstadoPedido.ESPERANDO_APROBACION,
];

/**
 * El grupo completo "la pelota está del lado del cliente / el mostrador":
 * `ESPERA_CLIENTE` más `EN_ATENCION` (ya lo llamaron). `esperaClienteDesdeAt`
 * mide la antigüedad de la espera y por eso NO se reinicia al moverse DENTRO de
 * este grupo (llamar, devolver a la cola, resolver una propuesta).
 */
export const ESTADOS_BOLSA_APARTADA: EstadoPedido[] = [
  ...ESTADOS_ESPERA_CLIENTE,
  EstadoPedido.EN_ATENCION,
];

export function clientePresenteEnTienda(pedido: {
  canalOrigen: string;
  llegadaAnunciadaAt: Date | null;
  llegadaDescartadaAt: Date | null;
}): boolean {
  if (pedido.llegadaDescartadaAt) return false;
  if (pedido.canalOrigen === CanalOrigen.KIOSKO) return true;
  return Boolean(pedido.llegadaAnunciadaAt);
}

/**
 * El mismo predicado, en forma de `where` de Prisma. Es lo que usan la cola, la
 * TV y `llamarSiguiente`: si divergieran, la TV y la consola mostrarían colas
 * distintas y el operador llamaría a alguien que no está en la pantalla.
 */
export function wherePresente(): Prisma.PedidoWhereInput {
  return {
    llegadaDescartadaAt: null,
    OR: [
      { canalOrigen: CanalOrigen.KIOSKO },
      { canalOrigen: CanalOrigen.WEB, llegadaAnunciadaAt: { not: null } },
    ],
  };
}

/**
 * Lo contrario de `wherePresente`: la bolsa está apartada pero el cliente no
 * está (web que nunca avisó, o aviso descartado; kiosko descartado). Es la lista
 * "Sin aviso" del mostrador y el contador `sinCliente` de la TV.
 */
export function whereAusente(): Prisma.PedidoWhereInput {
  return {
    OR: [
      { llegadaDescartadaAt: { not: null } },
      { canalOrigen: CanalOrigen.WEB, llegadaAnunciadaAt: null },
    ],
  };
}

/**
 * El orden de la cola: "primero llegado, primero atendido".
 *
 * `presenteDesdeAt` es la hora del pedido (kiosko) o del aviso (web). Los
 * pedidos sin esa marca (no deberían estar en la cola) van al final; el resto
 * del orden es un desempate estable.
 */
export const ORDEN_COLA: Prisma.PedidoOrderByWithRelationInput[] = [
  { presenteDesdeAt: { sort: 'asc', nulls: 'last' } },
  { fechaPedido: 'asc' },
  { id: 'asc' },
];

/** Minutos completos que lleva el cliente esperando (null si no está). */
export function minutosEsperando(
  pedido: {
    canalOrigen: string;
    llegadaAnunciadaAt: Date | null;
    llegadaDescartadaAt: Date | null;
    presenteDesdeAt: Date | null;
    fechaPedido: Date;
  },
  ahora: number = Date.now(),
): number | null {
  if (!clientePresenteEnTienda(pedido)) return null;
  const desde = pedido.presenteDesdeAt ?? pedido.llegadaAnunciadaAt ?? pedido.fechaPedido;
  return Math.max(0, Math.floor((ahora - desde.getTime()) / 60_000));
}
