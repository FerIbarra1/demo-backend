/**
 * Constantes de negocio del dominio de pedidos, compartidas entre services
 * sin arrastrar el árbol de dependencias de un service concreto.
 *
 * F6 (jul 2026): el monitor de bodega muestra hasta MAX_PEDIDOS_POR_BODEGUERO
 * slots por bodeguero. Cambiar este valor requiere también ajustar el DTO y
 * el render de la tarjeta del bodeguero en el frontend.
 */
export const MAX_PEDIDOS_POR_BODEGUERO = 4;
