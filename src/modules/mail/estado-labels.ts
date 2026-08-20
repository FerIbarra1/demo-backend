import { EstadoPedido } from '@prisma/client';

/**
 * Mapeo del enum EstadoPedido a texto legible en español para mostrar en
 * emails al cliente. Sin emojis, sin jerga técnica — sólo el nombre que
 * tiene sentido para una persona que está del lado del cliente.
 */
export const ESTADO_PEDIDO_LABELS: Record<EstadoPedido, string> = {
  PENDING_REVIEW: 'Recibido · en cola de revisión',
  REVIEWING: 'En revisión por bodega',
  WAITING_CUSTOMER_APPROVAL: 'Propuesta del bodeguero pendiente de tu aprobación',
  APPROVED: 'Aprobado · listo para pago',
  PENDING_PAID: 'Pendiente de pago',
  PAID: 'Pago confirmado',
  SHIPPED: 'Enviado · en camino',
  COMPLETED: 'Entregado',
  CANCELLED: 'Cancelado',
};

/**
 * Devuelve el label legible en español para un estado. Si llega un valor
 * desconocido (caso muy raro, p.ej. nuevo estado agregado al schema sin
 * actualizar este mapa), devuelve el valor crudo en vez de crashear.
 */
export function estadoPedidoLabel(estado: string): string {
  return ESTADO_PEDIDO_LABELS[estado as EstadoPedido] ?? estado;
}
