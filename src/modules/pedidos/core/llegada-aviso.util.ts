import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Regla única de "¿este pedido ya se puede avisar en tienda?".
 *
 * F16 (sep 2026): el aviso de llegada solo tiene sentido cuando el pedido YA
 * ESTÁ LISTO para revisarse en tienda, es decir en `REVISADO`. Ese estado
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
  [EstadoPedido.SOLICITADO]:
    'Tu pedido todavía está en cola de revisión. Te avisamos cuando esté listo.',
  [EstadoPedido.EN_REVISION]:
    'Bodega está preparando tu pedido. Podrás avisar tu llegada cuando esté listo.',
  [EstadoPedido.ESPERANDO_APROBACION]:
    'Tienes una propuesta pendiente de aprobar. Tu pedido estará listo cuando la respondas.',
  [EstadoPedido.EN_ASESORIA]:
    'Un asesor está viendo tu pedido. Podrás avisar tu llegada cuando esté listo.',
  // F17: el operador ya lo llamó y lo está atendiendo. Si el cliente intenta
  // avisar de nuevo, la verdad es que ya está siendo atendido — no que "aún
  // no está listo".
  [EstadoPedido.EN_ATENCION]:
    'Ya te estamos atendiendo en mostrador. Si no ves tu pedido, avísale al operador.',
  [EstadoPedido.PENDIENTE_PAGO]:
    'Tu pedido ya pasó a caja. Pasa a la ventanilla que te indiquen para pagar.',
  [EstadoPedido.PAGADO]:
    'Tu pedido ya está pagado. Acércate al mostrador con tu folio y te lo entregamos.',
  [EstadoPedido.ENVIADO]: 'Tu pedido ya fue enviado.',
  [EstadoPedido.ENTREGADO]: 'Ese pedido ya fue entregado.',
  [EstadoPedido.CANCELADO]: 'Ese pedido está cancelado. Pasa al mostrador para revisarlo.',
};

/**
 * Quién avisa. Cambia la regla de fondo:
 *
 *  - `CLIENTE`: el cliente desde su casa o desde el kiosko. Solo tiene sentido
 *    cuando el pedido YA está listo (`REVISADO`); antes de eso no hay nada
 *    que mostrarle y avisar sería ruido en la consola.
 *  - `OPERADOR`: el de mostrador, con el cliente ENFRENTE. Aquí el aviso no es
 *    "voy en camino", es "esta persona está aquí ahora". Por eso se permite en
 *    cualquier estado no terminal: el pedido puede seguir en bodega, esperando
 *    que el cliente apruebe una propuesta, o ya en caja — y en todos esos casos
 *    el operador necesita dejar constancia y saber qué decirle.
 *
 * Oct 2026: el caso que lo motivó es el cliente que llega sin ticket y sin
 * folio. Antes, si su pedido no estaba en `EN_MOSTRADOR`, el operador recibía un
 * 409 y se quedaba sin salida.
 */
export type OrigenAviso = 'CLIENTE' | 'OPERADOR';

export interface ResultadoAviso {
  /** ¿Se puede registrar el aviso? */
  puede: boolean;
  /**
   * ¿Este aviso mete al pedido en la cola del mostrador AHORA?
   *
   * Es `true` SOLO en `REVISADO`, y es el dato que el frontend usa para
   * elegir el copy ("ya está en la cola" vs. "avisamos a bodega"). Marcar la
   * llegada en `EN_REVISION` NO mete el pedido a la cola: el gate de visibilidad
   * sigue exigiendo `REVISADO`. Cuando bodega termine, el pedido llega a la
   * cola con su badge EN TIENDA y su `esperandoDesdeMin` contando desde que el
   * cliente llegó de verdad — que es justo lo que se quiere.
   */
  entraACola: boolean;
  /** Presente solo cuando `puede` es `false`. */
  codigo?: MotivoNoAvisable['codigo'];
  /** Texto para el cliente / para el operador. */
  message: string;
}

/**
 * La regla única de "¿se puede registrar este aviso de llegada?".
 *
 * No lanza: el caller decide la excepción (kiosko y mostrador usan
 * `ConflictException` con `codigo`; el cliente autenticado usa
 * `BadRequestException` con el mensaje plano).
 */
export function evaluarAviso(
  pedido: { estado: EstadoPedido; modoEntrega: ModoEntrega },
  origen: OrigenAviso,
): ResultadoAviso {
  // El modo de entrega se valida ANTES que el estado: un pedido a domicilio no
  // se recoge en tienda aunque esté listo, y decirle al cliente "ya casi está"
  // sería peor que decirle la verdad.
  if (
    pedido.modoEntrega !== ModoEntrega.RECOGER_TIENDA &&
    pedido.modoEntrega !== ModoEntrega.KIOSKO
  ) {
    return {
      puede: false,
      entraACola: false,
      codigo: 'ES_A_DOMICILIO',
      message: 'Ese pedido es a domicilio, no se recoge en tienda.',
    };
  }

  const entraACola = pedido.estado === EstadoPedido.REVISADO;

  // El operador puede marcar la presencia en cualquier estado no terminal. Los
  // terminales son la única excepción: ya no hay nada que hacer con el pedido, y
  // "el cliente está aquí" sobre algo ya entregado o cancelado solo confunde.
  if (origen === 'OPERADOR' && !TERMINALES.has(pedido.estado)) {
    return {
      puede: true,
      entraACola,
      message: entraACola
        ? 'Llegada registrada. El pedido ya está en la cola del mostrador.'
        : 'Llegada registrada. El equipo ya sabe que el cliente está aquí.',
    };
  }

  if (entraACola) {
    return { puede: true, entraACola: true, message: '' };
  }

  const codigo: MotivoNoAvisable['codigo'] =
    pedido.estado === EstadoPedido.ENTREGADO
      ? 'YA_ENTREGADO'
      : pedido.estado === EstadoPedido.CANCELADO
        ? 'CANCELADO'
        : 'AUN_NO_ESTA_LISTO';

  return {
    puede: false,
    entraACola: false,
    codigo,
    message:
      MENSAJES_POR_ESTADO[pedido.estado] ??
      'Tu pedido todavía no está listo para revisarse en tienda.',
  };
}

/** Estados terminales: ya no hay nada que operar. */
const TERMINALES = new Set<EstadoPedido>([EstadoPedido.ENTREGADO, EstadoPedido.CANCELADO]);

/**
 * Compatibilidad: la regla vista desde el CLIENTE.
 *
 * Se conserva como wrapper delgado para no tocar los dos callers existentes
 * (kiosko y app del cliente) en el mismo cambio que introduce `evaluarAviso`.
 * Los dos son equivalentes: `motivoNoAvisable(p) === null` ⟺
 * `evaluarAviso(p, 'CLIENTE').puede`.
 */
export function motivoNoAvisable(pedido: {
  estado: EstadoPedido;
  modoEntrega: ModoEntrega;
}): MotivoNoAvisable | null {
  const r = evaluarAviso(pedido, 'CLIENTE');
  if (r.puede) return null;
  return { codigo: r.codigo!, message: r.message };
}
