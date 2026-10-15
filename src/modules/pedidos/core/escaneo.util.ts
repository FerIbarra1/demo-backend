import { EstadoPedido, RolUsuario } from '@prisma/client';

/**
 * Oct 2026: "¿de quién es este pedido AHORA?" — la pieza que le faltaba al
 * escáner.
 *
 * El escáner navegaba a una ruta fija del rol (bodega → /bodega/pedidos/[id]),
 * así que escanear un pedido que ya había salido de bodega te dejaba en una
 * página que no aplicaba, o vacía. El cajero ni siquiera tiene página de
 * detalle, así que escanear desde caja no llevaba a ningún lado.
 *
 * El patrón de la industria (Toast KDS, NetSuite WMS, ISA Omnium) es NO navegar
 * a ciegas: resolver el código, y mostrar una superficie que dice en qué etapa
 * está el pedido y QUIÉN lo tiene. Si te toca a ti, la acción primaria; si no,
 * solo lectura con el nombre del área responsable — nunca un 403 ni una página
 * en blanco.
 */

export interface Responsable {
  /** Rol que opera el pedido en este estado. `null` si es terminal. */
  rol: RolUsuario | null;
  /** Nombre del área, para mostrar al operador. */
  label: string;
  /** Qué está pasando, en gerundio: "surtiendo", "esperando al cliente". */
  queHace: string;
}

const RESPONSABLES: Record<EstadoPedido, Responsable> = {
  [EstadoPedido.SOLICITADO]: {
    rol: RolUsuario.BODEGA,
    label: 'Bodega',
    queHace: 'por tomar',
  },
  [EstadoPedido.EN_REVISION]: {
    rol: RolUsuario.BODEGA,
    label: 'Bodega',
    queHace: 'surtiendo',
  },
  [EstadoPedido.ESPERANDO_APROBACION]: {
    rol: RolUsuario.CLIENTE,
    label: 'el cliente',
    queHace: 'esperando que apruebe una propuesta',
  },
  [EstadoPedido.EN_ASESORIA]: {
    rol: RolUsuario.VENTAS,
    label: 'Ventas',
    queHace: 'en asesoría',
  },
  [EstadoPedido.REVISADO]: {
    rol: RolUsuario.MOSTRADOR,
    label: 'Mostrador',
    queHace: 'en el área de entrega, esperando al cliente',
  },
  [EstadoPedido.EN_ATENCION]: {
    rol: RolUsuario.MOSTRADOR,
    label: 'Mostrador',
    queHace: 'atendiendo al cliente',
  },
  [EstadoPedido.PENDIENTE_PAGO]: {
    rol: RolUsuario.CAJERO,
    label: 'Caja',
    queHace: 'esperando el pago',
  },
  [EstadoPedido.PAGADO]: {
    rol: RolUsuario.MOSTRADOR,
    label: 'Mostrador',
    queHace: 'pagado, listo para entregar',
  },
  [EstadoPedido.ENVIADO]: {
    rol: RolUsuario.MOSTRADOR,
    label: 'Mostrador',
    queHace: 'enviado, pendiente de entrega',
  },
  [EstadoPedido.ENTREGADO]: {
    rol: null,
    label: 'nadie',
    queHace: 'ya entregado',
  },
  [EstadoPedido.CANCELADO]: {
    rol: null,
    label: 'nadie',
    queHace: 'cancelado',
  },
};

/** Estados terminales: ya no hay nada que operar. */
const TERMINALES = new Set<EstadoPedido>([EstadoPedido.ENTREGADO, EstadoPedido.CANCELADO]);

export function responsableDe(estado: EstadoPedido): Responsable {
  return RESPONSABLES[estado];
}

/**
 * ¿Este usuario puede OPERAR el pedido (no solo verlo)?
 *
 * Es la pregunta que decide si el panel del escáner ofrece la acción primaria o
 * cae a solo lectura. ADMIN siempre puede; el resto solo si su rol es el
 * responsable del estado actual.
 *
 * Ojo: es una condición NECESARIA, no suficiente. Los guards de cada acción
 * siguen validando lo suyo (asignación de bodeguero, ventanilla elegida, etc.).
 * Esto solo evita ofrecer un botón que va a fallar.
 */
export function puedeOperar(estado: EstadoPedido, rol: RolUsuario | undefined): boolean {
  if (!rol) return false;
  // Los terminales van primero: en COMPLETED/CANCELLED no hay acción que
  // ofrecer, ni siquiera para ADMIN. Devolver `true` ahí pintaría un botón
  // primario que no lleva a nada.
  if (TERMINALES.has(estado)) return false;
  if (rol === RolUsuario.ADMIN) return true;
  return RESPONSABLES[estado].rol === rol;
}

/**
 * Mensaje para el operador cuando el pedido NO es suyo. Explica qué pasó y
 * quién lo tiene — el patrón de Toast KDS ("otra estación debe cumplir este
 * ticket primero"), en vez de un error seco.
 */
export function mensajeNoEsTuyo(estado: EstadoPedido): string {
  const r = RESPONSABLES[estado];
  if (TERMINALES.has(estado)) {
    return estado === EstadoPedido.ENTREGADO
      ? 'Este pedido ya fue entregado.'
      : 'Este pedido está cancelado.';
  }
  return `Este pedido lo tiene ${r.label} (${r.queHace}).`;
}
