import { EstadoPedido, TipoTareaErp } from '@prisma/client';
import { yaFueCobrado } from '../pedidos/core/cobro.util';

/**
 * Oct 2026 — la CONCILIACIÓN ACTIVA, la regla pura: dado lo que dice el Sistema Comercial de UN pedido y lo que dice la
 * nube, ¿qué difiere, qué corrige la nube sola y qué tarea queda cumplida?
 *
 * El trigger `TRG_PEDIDOS_SYNC` avisa de los CAMBIOS; esto verifica el RESULTADO. Cubre lo que un evento perdido, un
 * agente caído una noche o un trigger que nadie instaló dejaron sin avisar: el cobro hecho en el Sistema Comercial que la
 * web nunca supo, o el pedido cancelado allá que acá sigue vivo.
 *
 * SOLO se corrige solo lo que el evento del trigger habría corregido igual (el cobro y la cancelación, por el MISMO
 * `PedidoPagoHandler`). Todo lo demás —un cobro en un pedido cancelado, un cobro que alguien desmarcó, un total distinto—
 * es dinero: se VE (queda en la salud del sistema) y lo decide una persona.
 *
 * Sin Prisma ni Nest: es una función de dos estados, y por eso se prueba entera con tablas.
 */

/** Lo que el agente leyó de `PEDIDOS` en Firebird. */
export interface EstadoErp {
  existe: boolean;
  swcancel: boolean;
  finalizada: boolean;
  /** `TTOTAL` en pesos. En un pedido cancelado el ERP lo deja en 0 (`CANCELA_PEDIDOS`): no se compara. */
  total: number | null;
}

/** Lo que la nube sabe del mismo pedido. */
export interface EstadoNube {
  estado: EstadoPedido;
  total: number;
  /** Tareas del Sistema Comercial ABIERTAS del pedido (lo que la nube ya sabe que falta reflejar allá). */
  tareasAbiertas: readonly TipoTareaErp[];
}

export type TipoHallazgo =
  /** El pedido tiene folio en la nube y el Sistema Comercial no lo encuentra. */
  | 'NO_EXISTE_EN_ERP'
  /** Cobrado en el ERP, PENDIENTE_PAGO en la nube. La nube lo marca PAGADO sola. */
  | 'COBRO_PERDIDO'
  /** Cancelado en el ERP, vivo en la nube. La nube lo cancela sola. */
  | 'CANCELACION_PERDIDA'
  /** Cobrado en el ERP y cancelado en la nube: hay dinero y nadie sabe qué hacer. Persona. */
  | 'COBRADO_Y_CANCELADO'
  /** PAGADO en la nube, sin cobro en el ERP y sin tarea que lo explique: alguien desmarcó el cobro. Persona. */
  | 'REVERSA_DE_COBRO'
  /** Cancelado en la nube, vivo en el ERP y sin tarea que lo explique. Persona. */
  | 'CANCELADO_VIVO_EN_ERP'
  /** El total de la nube y el del ERP ya no coinciden. Persona. */
  | 'TOTAL_DISTINTO'
  /** Cualquier otra combinación que no tiene sentido (p. ej. entregado en la nube y cancelado en el ERP). Persona. */
  | 'ESTADO_DISTINTO';

/** Los que la nube corrige sola: nacen ya resueltos (`curado`) y quedan como constancia. */
export const TIPOS_CURADOS: readonly TipoHallazgo[] = ['COBRO_PERDIDO', 'CANCELACION_PERDIDA'];

/** Los que tocan DINERO y deben verse en rojo en la salud del sistema. */
export const TIPOS_DE_DINERO: readonly TipoHallazgo[] = [
  'COBRADO_Y_CANCELADO',
  'REVERSA_DE_COBRO',
  'TOTAL_DISTINTO',
];

export interface Hallazgo {
  tipo: TipoHallazgo;
  /** Para el personal: qué dice cada lado. */
  detalle: Record<string, unknown>;
}

export interface Veredicto {
  hallazgos: Hallazgo[];
  /** Lo que la nube debe APLICAR como si el trigger hubiera avisado (por el handler de siempre). */
  aplicar: 'COBRO' | 'CANCELACION' | null;
  /** Tareas del Sistema Comercial que el ERP ya cumplió. */
  cerrarTareas: TipoTareaErp[];
}

/** Un centavo de redondeo no es una diferencia (mismo umbral que el handler de eventos). */
export const TOLERANCIA_TOTAL = 0.01;

const VIVO_EN_COBRO: readonly EstadoPedido[] = [EstadoPedido.PENDIENTE_PAGO];

export function conciliar(erp: EstadoErp, nube: EstadoNube): Veredicto {
  const v: Veredicto = { hallazgos: [], aplicar: null, cerrarTareas: [] };
  const lado = {
    nube: nube.estado,
    erp: { swcancel: erp.swcancel, finalizada: erp.finalizada, total: erp.total },
  };
  const hay = (t: TipoTareaErp) => nube.tareasAbiertas.includes(t);
  const tareaDeCancelar =
    hay(TipoTareaErp.CANCELAR_EN_ERP) || hay(TipoTareaErp.ANULAR_VENTA_EN_ERP);
  const cobradoEnNube = yaFueCobrado(nube.estado);

  if (!erp.existe) {
    // Un pedido que la nube ya cerró (cancelado o entregado) no necesita a su fila del ERP para nada.
    if (nube.estado !== EstadoPedido.CANCELADO && nube.estado !== EstadoPedido.ENTREGADO) {
      v.hallazgos.push({ tipo: 'NO_EXISTE_EN_ERP', detalle: lado });
    }
    return v;
  }

  if (erp.swcancel) {
    if (nube.estado === EstadoPedido.CANCELADO) {
      // Lo que la web canceló, el Sistema Comercial ya lo canceló: la tarea de cancelar está cumplida.
      // (ANULAR_VENTA no: devolver el dinero no se deduce de `SWCANCEL`.)
      if (hay(TipoTareaErp.CANCELAR_EN_ERP)) v.cerrarTareas.push(TipoTareaErp.CANCELAR_EN_ERP);
    } else if (nube.estado === EstadoPedido.ENTREGADO) {
      v.hallazgos.push({ tipo: 'ESTADO_DISTINTO', detalle: lado });
    } else {
      v.aplicar = 'CANCELACION';
      v.hallazgos.push({ tipo: 'CANCELACION_PERDIDA', detalle: lado });
    }
    return v;
  }

  if (erp.finalizada) {
    if (cobradoEnNube) {
      if (hay(TipoTareaErp.REGISTRAR_COBRO_EN_ERP)) {
        v.cerrarTareas.push(TipoTareaErp.REGISTRAR_COBRO_EN_ERP);
      }
    } else if (VIVO_EN_COBRO.includes(nube.estado)) {
      v.aplicar = 'COBRO';
      v.hallazgos.push({ tipo: 'COBRO_PERDIDO', detalle: lado });
    } else if (nube.estado === EstadoPedido.CANCELADO) {
      v.hallazgos.push({ tipo: 'COBRADO_Y_CANCELADO', detalle: lado });
    } else {
      // Cobrado en el ERP y la nube aún no lo manda a pagar (EN_ATENCION, REVISADO…): no tiene sentido.
      v.hallazgos.push({ tipo: 'ESTADO_DISTINTO', detalle: lado });
    }
  } else {
    // Sin cobro ni cancelación en el ERP.
    if (cobradoEnNube && !hay(TipoTareaErp.REGISTRAR_COBRO_EN_ERP)) {
      // Con la tarea abierta es lo esperado: la web cobró a mano y caja aún no lo registra allá.
      v.hallazgos.push({ tipo: 'REVERSA_DE_COBRO', detalle: lado });
    }
    if (nube.estado === EstadoPedido.CANCELADO && !tareaDeCancelar) {
      v.hallazgos.push({ tipo: 'CANCELADO_VIVO_EN_ERP', detalle: lado });
    }
  }

  // El total. Un pedido cancelado en el ERP se queda en 0 y sin líneas: ahí no hay nada que comparar (ya salió arriba).
  if (
    erp.total != null &&
    nube.estado !== EstadoPedido.CANCELADO &&
    Math.abs(erp.total - nube.total) > TOLERANCIA_TOTAL
  ) {
    v.hallazgos.push({
      tipo: 'TOTAL_DISTINTO',
      detalle: { ...lado, totalNube: nube.total, totalErp: erp.total },
    });
  }

  return v;
}

/** Texto para el personal: lo que se ve en la salud del sistema. El servidor lo redacta; la pantalla no lo reescribe. */
export function textoDeHallazgo(tipo: string): { titulo: string; que: string } {
  switch (tipo as TipoHallazgo) {
    case 'NO_EXISTE_EN_ERP':
      return {
        titulo: 'No existe en el Sistema Comercial',
        que: 'El pedido tiene folio en la web pero el Sistema Comercial no lo encuentra. Revisa que no lo hayan borrado allá.',
      };
    case 'COBRO_PERDIDO':
      return {
        titulo: 'Cobro que la web no sabía',
        que: 'Estaba cobrado en el Sistema Comercial y la web lo tenía por pagar. Se marcó pagado solo.',
      };
    case 'CANCELACION_PERDIDA':
      return {
        titulo: 'Cancelación que la web no sabía',
        que: 'Estaba cancelado en el Sistema Comercial y la web lo tenía vivo. Se canceló solo.',
      };
    case 'COBRADO_Y_CANCELADO':
      return {
        titulo: 'Cobrado y cancelado',
        que: 'El Sistema Comercial lo tiene cobrado y la web lo canceló. Hay dinero de por medio: decide si se devuelve o se reabre.',
      };
    case 'REVERSA_DE_COBRO':
      return {
        titulo: 'Cobro desmarcado',
        que: 'La web lo tiene pagado y en el Sistema Comercial ya no aparece cobrado. Alguien lo deshizo allá.',
      };
    case 'CANCELADO_VIVO_EN_ERP':
      return {
        titulo: 'Cancelado en la web y vivo en el Sistema Comercial',
        que: 'La web lo canceló y allá sigue vivo, sin tarea que lo explique. Cancélalo en el Sistema Comercial.',
      };
    case 'TOTAL_DISTINTO':
      return {
        titulo: 'El total no coincide',
        que: 'La web y el Sistema Comercial ya no hablan del mismo monto. Alguien editó el pedido en uno de los dos.',
      };
    default:
      return {
        titulo: 'Estados que no cuadran',
        que: 'La web y el Sistema Comercial dicen cosas que no pueden ser ciertas a la vez. Revisa el pedido.',
      };
  }
}
