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
 * F13 (sep 2026): estados que ocupan un slot del bodeguero (cuentan hacia
 * MAX_PEDIDOS_POR_BODEGUERO).
 *
 * Antes incluía WAITING_CUSTOMER_APPROVAL, porque el pedido seguía asignado
 * al bodeguero mientras el cliente decidía. Con el flujo nuevo el bodeguero
 * ya no puede accionar nada en cuanto envía la propuesta — la pelota es del
 * cliente — así que el pedido libera el slot y el bodeguero puede tomar otros.
 *
 * Centralizado aquí para que todos los callers (obtenerMisPedidosBodeguero,
 * tomarGrupo, puedeTomarOtro, monitor) cuenten lo mismo.
 */
export const ESTADOS_OCUPAN_SLOT_BODEGA: EstadoPedido[] = [EstadoPedido.REVIEWING];
