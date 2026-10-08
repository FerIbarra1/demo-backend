import { EstadoPedido } from '@prisma/client';

/**
 * Mapeo del enum EstadoPedido a texto legible en español para mostrar en
 * emails al cliente. Sin emojis, sin jerga técnica — sólo el nombre que
 * tiene sentido para una persona que está del lado del cliente.
 */
export const ESTADO_PEDIDO_LABELS: Record<EstadoPedido, string> = {
  SOLICITADO: 'Recibido · en cola de revisión',
  EN_REVISION: 'En revisión por bodega',
  ESPERANDO_APROBACION: 'Propuesta pendiente de tu aprobación',
  EN_ASESORIA: 'Con un asesor de ventas',
  // F16 (sep 2026): el pedido está apartado en tienda esperando que el cliente
  // lo revise antes de pagar.
  REVISADO: 'Listo en tienda · revísalo',
  // F17: el operador ya lo está atendiendo. El cliente no recibe email de este
  // paso (está enfrente), pero el mapa es exhaustivo y el valor hace falta.
  EN_ATENCION: 'Te estamos atendiendo en mostrador',
  PENDIENTE_PAGO: 'Pendiente de pago',
  PAGADO: 'Pago confirmado',
  ENVIADO: 'Enviado · en camino',
  ENTREGADO: 'Entregado',
  CANCELADO: 'Cancelado',
};

/**
 * Devuelve el label legible en español para un estado. Si llega un valor
 * desconocido (caso muy raro, p.ej. nuevo estado agregado al schema sin
 * actualizar este mapa), devuelve el valor crudo en vez de crashear.
 */
export function estadoPedidoLabel(estado: string): string {
  return ESTADO_PEDIDO_LABELS[estado as EstadoPedido] ?? estado;
}
