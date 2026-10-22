import { EstadoPagoTransferencia, EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Oct 2026 — ¿puede el CLIENTE cancelar este pedido y, si no, por qué?
 *
 * UNA función, tres consumidores: la cancelación real (`ClienteService.cancelarPedido`), «Mis pedidos» y el detalle del
 * pedido. Antes había cuatro reglas distintas —el botón de la lista con 4 estados, `PedidoApartadoCard`, el «Cancelar
 * pedido» de la propuesta y el servidor con 7— y el cliente se enteraba del bloqueo hasta que el servidor contestaba
 * 409. Ahora el botón no puede contradecir al servidor: salen de la misma decisión.
 *
 * Pura (sin Prisma ni Nest) para poder cruzarla con TODOS los estados y TODOS los estados de pago en una tabla.
 *
 * Decisiones del dueño (19-oct-2026):
 *  · SÍ cancela: Recibido, En preparación, Pendiente de aprobación, Con asesor, Listo en tienda y Pendiente de pago
 *    SIN comprobante enviado.
 *  · «En atención» se CIERRA: el cliente está con el operador y cancelar a mitad del recuento solo causa conflictos
 *    (la cancelación del operador de mostrador no cambia).
 *  · NO cancela: comprobante en revisión o transferencia verificada (primero se resuelve el dinero); Pagado, Enviado y
 *    Entregado (→ mostrador); EN_DTF (sus trabajos se cancelan desde su tarjeta DTF).
 *  · Con una transferencia PENDIENTE (dinero posiblemente en camino) el diálogo pregunta «¿ya transferiste?».
 *
 * El texto lo lee el cliente: sin «bodega», «administrador» ni «Sistema Comercial» (ver el vocabulario del frontend).
 */

export type CodigoNoCancelable =
  | 'YA_CANCELADO'
  | 'EN_ATENCION'
  | 'EN_DTF'
  | 'PAGO_EN_REVISION'
  | 'PAGO_VERIFICADO'
  | 'YA_PAGADO'
  | 'ENTREGADO';

export interface DecisionCancelacion {
  puede: boolean;
  /** Por qué no (estable: lo usan las pruebas y el cuerpo del 409); `null` si puede. */
  codigo: CodigoNoCancelable | null;
  /** Lo que lee el cliente cuando no puede; `null` si puede. */
  motivo: string | null;
  /** El diálogo avisa que la mercancía que apartamos vuelve al anaquel. */
  mercanciaApartada: boolean;
  /** Hay una transferencia PENDIENTE: el diálogo pregunta «¿ya transferiste?» antes de cancelar. */
  preguntarTransferencia: boolean;
}

/**
 * Estados en los que la bolsa ya salió de las manos de bodega y está apartada en tienda. Sirve para el AVISO del
 * diálogo; qué se lista en reposición lo sigue decidiendo `bolsaEnManosDeBodega` al cancelar. Un pedido que volvió a
 * `EN_REVISION` por un ajuste también tiene su bolsa en la mesa, pero el aviso no lo menciona: es solo un aviso.
 */
const ESTADOS_CON_MERCANCIA_APARTADA: readonly EstadoPedido[] = [
  EstadoPedido.REVISADO,
  EstadoPedido.ESPERANDO_APROBACION,
  EstadoPedido.EN_ASESORIA,
  EstadoPedido.PENDIENTE_PAGO,
];

/** El pago que importa para decidir (a lo más uno vivo por pedido), o `null` si el pedido no tiene. */
export type EstadoPagoParaCancelar = EstadoPagoTransferencia | null;

const NO: Omit<DecisionCancelacion, 'codigo' | 'motivo'> = {
  puede: false,
  mercanciaApartada: false,
  preguntarTransferencia: false,
};

export function decidirCancelacionDelCliente(
  pedido: { estado: EstadoPedido; modoEntrega?: ModoEntrega | null },
  pago: EstadoPagoParaCancelar,
): DecisionCancelacion {
  const bloqueado = (codigo: CodigoNoCancelable, motivo: string): DecisionCancelacion => ({
    ...NO,
    codigo,
    motivo,
  });
  const domicilio = pedido.modoEntrega === ModoEntrega.DOMICILIO;
  // A domicilio no hay mostrador al que ir: se le manda a hablar con la tienda.
  const aDondeIr = domicilio ? 'Comunícate con la tienda' : 'Acércate a mostrador';

  // El ESTADO manda sobre el pago: un pedido ya pagado no se cancela, tenga el pago que tenga.
  switch (pedido.estado) {
    case EstadoPedido.CANCELADO:
      return bloqueado('YA_CANCELADO', 'Este pedido ya está cancelado.');
    case EstadoPedido.PAGADO:
    case EstadoPedido.ENVIADO:
      return bloqueado(
        'YA_PAGADO',
        `Tu pedido ya fue pagado, así que no se puede cancelar desde aquí. ${aDondeIr} para cualquier cambio.`,
      );
    case EstadoPedido.ENTREGADO:
      return bloqueado(
        'ENTREGADO',
        `Tu pedido ya fue entregado, así que no se puede cancelar. Si algo no está bien, ${aDondeIr.toLowerCase()}.`,
      );
    case EstadoPedido.EN_ATENCION:
      // Decisión del dueño: a mitad del recuento el pedido es de quien te atiende. No es un error del cliente: es
      // que la cancelación se hace con la persona que tiene su pedido en las manos.
      return bloqueado(
        'EN_ATENCION',
        'Te están atendiendo en mostrador. Si ya no quieres tu pedido, díselo a la persona que te atiende.',
      );
    case EstadoPedido.EN_DTF:
      return bloqueado(
        'EN_DTF',
        'Este pedido está esperando la impresión de tus diseños DTF. Para cancelarlo, cancela cada diseño desde su tarjeta en el detalle del pedido.',
      );
    default:
      break;
  }

  // Estado cancelable: ahora el dinero. Con un comprobante por revisar (puede haber dinero en camino) o dinero ya
  // verificado, cancelar deja un dinero sin dueño: primero se resuelve el dinero (Tesorería / mostrador).
  if (pago === EstadoPagoTransferencia.VERIFICADO) {
    return bloqueado(
      'PAGO_VERIFICADO',
      `Tu transferencia ya fue verificada, así que no puedes cancelar el pedido desde aquí. ${aDondeIr}.`,
    );
  }
  if (pago === EstadoPagoTransferencia.EN_REVISION) {
    return bloqueado(
      'PAGO_EN_REVISION',
      'Ya enviaste un comprobante de transferencia y lo estamos revisando. Espera a que lo confirmemos, o contacta a la tienda.',
    );
  }

  return {
    puede: true,
    codigo: null,
    motivo: null,
    mercanciaApartada: ESTADOS_CON_MERCANCIA_APARTADA.includes(pedido.estado),
    preguntarTransferencia: pago === EstadoPagoTransferencia.PENDIENTE,
  };
}

/**
 * Las banderas que viajan en «Mis pedidos» y en el detalle. Una sola forma, para que la lista y el detalle no puedan
 * decir cosas distintas del mismo pedido. La pantalla las pinta y no las interpreta.
 */
export function banderasDeCancelacion(d: DecisionCancelacion) {
  return {
    puedeCancelar: d.puede,
    motivoNoPuedeCancelar: d.motivo,
    /** El diálogo avisa que la mercancía apartada vuelve al anaquel. */
    cancelarDevuelveMercancia: d.mercanciaApartada,
    /** El diálogo pregunta «¿ya transferiste?» antes de dejar cancelar. */
    cancelarPideConfirmarTransferencia: d.preguntarTransferencia,
  };
}
