import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Regla única de "¿este pedido ya se puede avisar en tienda?".
 *
 * F16 (sep 2026): el aviso de llegada solo tiene sentido cuando el pedido YA
 * ESTÁ LISTO para revisarse en tienda, es decir en `EN_MOSTRADOR`. Ese estado
 * es exactamente el punto en que bodega terminó de verificar, o el cliente
 * aprobó las modificaciones que bodega o ventas propusieron. Antes de eso el
 * pedido no está apartado, así que avisar no tendría sentido: el mostrador no
 * tiene nada que mostrarle.
 *
 * Oct 2026: esta regla vivía DUPLICADA en `kiosko-llegada.service.ts` y en
 * `cliente.service.ts`, con mapas de mensajes que ya habían divergido (el
 * mismo estado daba dos textos distintos según dónde mirara el cliente). Con
 * un tercer camino —el operador de mostrador marcando la llegada en nombre del
 * cliente— una tercera copia era insostenible. Ahora hay una sola fuente.
 *
 * Se devuelve el motivo en vez de lanzar la excepción para que cada caller
 * elija el tipo: el kiosko y mostrador usan `ConflictException` con `codigo`
 * (la tablet y la consola lo leen), el cliente autenticado usa
 * `BadRequestException` con el mensaje plano.
 */
export interface MotivoNoAvisable {
  /** Código estable para que el frontend distinga el caso sin parsear texto. */
  codigo: 'ES_A_DOMICILIO' | 'YA_ENTREGADO' | 'CANCELADO' | 'AUN_NO_ESTA_LISTO';
  /** Texto para el cliente. */
  message: string;
}

/**
 * Mensajes canónicos por estado. Los comparten las tres superficies (kiosko,
 * app del cliente y mostrador) para que el cliente lea lo mismo sin importar
 * por dónde avise.
 */
const MENSAJES_POR_ESTADO: Partial<Record<EstadoPedido, string>> = {
  [EstadoPedido.PENDING_REVIEW]:
    'Tu pedido todavía está en cola de revisión. Te avisamos cuando esté listo.',
  [EstadoPedido.REVIEWING]:
    'Bodega está preparando tu pedido. Podrás avisar tu llegada cuando esté listo.',
  [EstadoPedido.WAITING_CUSTOMER_APPROVAL]:
    'Tienes una propuesta pendiente de aprobar. Tu pedido estará listo cuando la respondas.',
  [EstadoPedido.EN_ASESORIA]:
    'Un asesor está viendo tu pedido. Podrás avisar tu llegada cuando esté listo.',
  [EstadoPedido.PENDING_PAID]:
    'Tu pedido ya pasó a caja. Pasa a la ventanilla que te indiquen para pagar.',
  [EstadoPedido.PAID]:
    'Tu pedido ya está pagado. Acércate al mostrador con tu folio y te lo entregamos.',
  [EstadoPedido.SHIPPED]: 'Tu pedido ya fue enviado.',
  [EstadoPedido.COMPLETED]: 'Ese pedido ya fue entregado.',
  [EstadoPedido.CANCELLED]: 'Ese pedido está cancelado. Pasa al mostrador para revisarlo.',
};

/**
 * Devuelve el motivo por el que el pedido NO se puede avisar, o `null` si sí
 * se puede. No lanza: el caller decide la excepción.
 */
export function motivoNoAvisable(pedido: {
  estado: EstadoPedido;
  modoEntrega: ModoEntrega;
}): MotivoNoAvisable | null {
  if (
    pedido.modoEntrega !== ModoEntrega.RECOGER_TIENDA &&
    pedido.modoEntrega !== ModoEntrega.KIOSKO
  ) {
    return {
      codigo: 'ES_A_DOMICILIO',
      message: 'Ese pedido es a domicilio, no se recoge en tienda.',
    };
  }

  if (pedido.estado === EstadoPedido.EN_MOSTRADOR) return null;

  const codigo: MotivoNoAvisable['codigo'] =
    pedido.estado === EstadoPedido.COMPLETED
      ? 'YA_ENTREGADO'
      : pedido.estado === EstadoPedido.CANCELLED
        ? 'CANCELADO'
        : 'AUN_NO_ESTA_LISTO';

  return {
    codigo,
    message:
      MENSAJES_POR_ESTADO[pedido.estado] ??
      'Tu pedido todavía no está listo para revisarse en tienda.',
  };
}
