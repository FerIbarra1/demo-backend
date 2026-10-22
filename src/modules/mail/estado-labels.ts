import { EstadoPedido } from '@prisma/client';

/**
 * Mapeo del enum EstadoPedido a texto legible en español para el CLIENTE (hoy lo lee el kiosko en "Estado:" al avisar la
 * llegada). Sin emojis, sin jerga técnica y en VOZ NEUTRA (sin "tu" ni imperativos).
 *
 * Es la MISMA tabla que `ETIQUETA_ESTADO` del frontend (`lib/utils/seguimiento.ts`): las mismas palabras que la barra de
 * pasos del pedido. Oct 2026: antes el kiosko decía "Listo en tienda · revísalo" y "Te estamos atendiendo en mostrador", y la
 * app tres frases distintas para el mismo estado. `estado-labels.spec.ts` fija los valores; el frontend los fija en
 * `scripts/test-seguimiento.ts`: si se cambia uno hay que cambiar el otro.
 */
export const ESTADO_PEDIDO_LABELS: Record<EstadoPedido, string> = {
  SOLICITADO: 'Recibido',
  EN_REVISION: 'En preparación',
  ESPERANDO_APROBACION: 'Pendiente de aprobación',
  EN_ASESORIA: 'Con un asesor de ventas',
  EN_DTF: 'En impresión DTF',
  REVISADO: 'Listo en tienda',
  EN_ATENCION: 'En atención en mostrador',
  PENDIENTE_PAGO: 'Pendiente de pago',
  PAGADO: 'Pagado',
  ENVIADO: 'Enviado',
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
