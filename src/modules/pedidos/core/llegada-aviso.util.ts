import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * Regla única de "¿se puede registrar el aviso de llegada de este pedido?".
 *
 * F22 (oct 2026): el cliente puede avisar su llegada en CUALQUIER estado no
 * terminal de un pedido que se recoge en tienda — también antes de que bodega
 * termine. Antes solo en `REVISADO` y el cliente que llegaba temprano no tenía
 * cómo decirlo (la app le ocultaba el botón y el kiosko respondía 409), aunque
 * el sistema YA dependía de ese dato: bodega prioriza a los clientes presentes y
 * `destinoTrasSurtidoIncompleto` decide si el faltante lo resuelve el mostrador o
 * el cliente en su app según haya o no un aviso. Si el cliente no podía avisar,
 * esas dos decisiones se tomaban a ciegas.
 *
 * El aviso es una SEÑAL, no un estado: no mueve el pedido (salvo el caso de
 * `PresenciaService.alLlegarCliente`, un pedido que espera aprobación). Qué hace
 * cada estado con ella:
 *
 *   SOLICITADO / EN_REVISION  bodega lo ve con prioridad. NO sale en la TV: aún
 *                             no hay nada que mostrarle al cliente.
 *   ESPERANDO_APROBACION      pasa al área de entrega: el operador resuelve la
 *                             propuesta con el cliente enfrente.
 *   EN_ASESORIA               el asesor se entera de que el cliente está ahí.
 *   REVISADO                  entra a la cola de la TV.
 *   PENDIENTE_PAGO en adelante  solo deja constancia (el cajero y el mostrador de
 *                             entrega ya ordenan por aviso).
 *
 * Oct 2026 (anterior): esta regla vivía DUPLICADA en `kiosko-llegada.service.ts`
 * y en `cliente.service.ts`, con mapas de mensajes que ya habían divergido. Ahora
 * hay una sola fuente.
 *
 * Se devuelve el motivo en vez de lanzar la excepción para que cada caller
 * elija el tipo: el kiosko y mostrador usan `ConflictException` con `codigo`
 * (la tablet y la consola lo leen), el cliente autenticado usa
 * `BadRequestException` con el mensaje plano.
 */
export interface MotivoNoAvisable {
  /** Código estable para que el frontend distinga el caso sin parsear texto. */
  codigo: 'ES_A_DOMICILIO' | 'YA_ENTREGADO' | 'CANCELADO';
  /** Texto para el cliente. */
  message: string;
}

/**
 * Mensajes de los estados donde NO se puede avisar (los terminales). Los
 * comparten las tres superficies (kiosko, app del cliente y mostrador) para que
 * el cliente lea lo mismo sin importar por dónde avise.
 */
const MENSAJES_TERMINALES: Partial<Record<EstadoPedido, string>> = {
  [EstadoPedido.ENTREGADO]: 'Ese pedido ya fue entregado.',
  [EstadoPedido.CANCELADO]: 'Ese pedido está cancelado. Pasa al mostrador para revisarlo.',
};

/**
 * Quién avisa. Ya no cambia QUÉ estados se aceptan (F22: los dos pueden avisar
 * en cualquier estado no terminal), solo el texto de la confirmación:
 *
 *  - `CLIENTE`: el cliente desde su casa, su teléfono o el kiosko ("voy en
 *    camino" / "ya llegué").
 *  - `OPERADOR`: el de mostrador, con el cliente ENFRENTE. Aquí el aviso es
 *    "esta persona está aquí ahora", y el operador necesita saber qué hizo el
 *    sistema con ella.
 *
 * Oct 2026: el caso que motivó el aviso del operador es el cliente que llega sin
 * ticket y sin folio. Antes, si su pedido no estaba en `REVISADO`, el operador
 * recibía un 409 y se quedaba sin salida.
 */
export type OrigenAviso = 'CLIENTE' | 'OPERADOR';

export interface ResultadoAviso {
  /** ¿Se puede registrar el aviso? */
  puede: boolean;
  /**
   * ¿Este aviso deja al pedido en la cola del mostrador AHORA?
   *
   * Es el dato que el frontend usa para elegir el copy ("ya está en la cola" vs.
   * "avisamos a bodega"). `true` en `REVISADO` y `EN_ATENCION` (ya está ahí) y en
   * `ESPERANDO_APROBACION` (el aviso lo mueve al área de entrega; ver
   * `PresenciaService.alLlegarCliente`). En `EN_REVISION` NO: el pedido sigue en
   * bodega y entrará a la cola, con su badge EN TIENDA contando desde que el
   * cliente llegó de verdad, cuando bodega termine.
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

  // Los terminales son la única excepción: ya no hay nada que hacer con el
  // pedido, y "el cliente está aquí" sobre algo ya entregado o cancelado solo
  // confunde.
  if (TERMINALES.has(pedido.estado)) {
    return {
      puede: false,
      entraACola: false,
      codigo: pedido.estado === EstadoPedido.ENTREGADO ? 'YA_ENTREGADO' : 'CANCELADO',
      message: MENSAJES_TERMINALES[pedido.estado] ?? 'Ese pedido ya no admite cambios.',
    };
  }

  const entraACola =
    pedido.estado === EstadoPedido.REVISADO ||
    pedido.estado === EstadoPedido.EN_ATENCION ||
    pedido.estado === EstadoPedido.ESPERANDO_APROBACION;

  if (origen === 'OPERADOR') {
    return {
      puede: true,
      entraACola,
      message: entraACola
        ? 'Llegada registrada. El pedido ya está en la cola del mostrador.'
        : 'Llegada registrada. El equipo ya sabe que el cliente está aquí.',
    };
  }

  return { puede: true, entraACola, message: '' };
}

/** Estados terminales: ya no hay nada que operar. */
const TERMINALES = new Set<EstadoPedido>([EstadoPedido.ENTREGADO, EstadoPedido.CANCELADO]);

/**
 * Compatibilidad: la regla vista desde el CLIENTE (F22: ya solo rechaza los
 * terminales y los pedidos a domicilio).
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
