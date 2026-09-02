import { EstadoPedido } from '@prisma/client';

/**
 * Constantes de negocio del dominio de pedidos, compartidas entre services
 * sin arrastrar el árbol de dependencias de un service concreto.
 *
 * F6 (jul 2026): el monitor de bodega muestra hasta MAX_PEDIDOS_POR_BODEGUERO
 * slots por bodeguero. Cambiar este valor requiere también ajustar el DTO y
 * el render de la tarjeta del bodeguero en el frontend.
 */
export const MAX_PEDIDOS_POR_BODEGUERO = 4;

/**
 * F12 (sep 2026): estados que ocupan un slot del bodeguero (cuentan hacia
 * MAX_PEDIDOS_POR_BODEGUERO). Un pedido en WAITING_CUSTOMER_APPROVAL sigue
 * asignado al bodeguero (esperando al cliente), así que ocupa slot.
 * Centralizado aquí para que todos los callers (obtenerMisPedidosBodeguero,
 * tomarGrupo, puedeTomarOtro, monitor) cuenten lo mismo.
 */
export const ESTADOS_OCUPAN_SLOT_BODEGA: EstadoPedido[] = [
  EstadoPedido.REVIEWING,
  EstadoPedido.WAITING_CUSTOMER_APPROVAL,
];
