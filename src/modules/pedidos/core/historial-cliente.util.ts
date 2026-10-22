/**
 * Oct 2026 — el historial que LEE el cliente.
 *
 * `HistorialPedido` se escribe para el personal (quién tomó el pedido, qué propuesta se resolvió, «Llamado a mostrador 2
 * por Ana») y el detalle del pedido del cliente lo pintaba tal cual: leía «propuesta #45», «por AGENT_EXTERNAL», «pasa al
 * final de la cola». Números internos, nombres de procesos y movimientos del piso que no le dicen nada o lo confunden.
 *
 * Decisión (19-oct-2026): **el cliente ve solo los hitos de SU pedido, escritos para él.**
 *
 *   - Solo cuentan los CAMBIOS de estado reales; los movimientos del mismo estado (una llamada, un descarte, un aviso de
 *     llegada, tomar o liberar) son operativos.
 *   - Cada hito se cuenta con una frase FIJA en su voz («Recibimos tu pedido», «Tu pedido quedó listo en tienda»,
 *     «Recibimos tu pago»), no con el texto libre del personal, que lleva nombres, jerga y ids. Por construcción ningún
 *     texto de piso puede llegar a la pantalla del cliente.
 *   - Los vaivenes internos no aparecen (deshacer una llamada, devolver a la cola de preparación) y dos frases iguales
 *     seguidas se funden en una.
 *   - NO se muestra quién lo hizo: el nombre de un empleado no le sirve al cliente (y es dato del empleado).
 *   - El motivo de una cancelación vive en el aviso del pedido (`avisoDeTienda`), no aquí.
 *
 * Vive aquí, en el punto donde se le entrega el historial (`ClienteService.obtenerMiPedido`), y no en los ~60 sitios que
 * escriben una observación. Es también lo único que limpia los pedidos ya guardados con el texto viejo. Entrega solo lo
 * que la pantalla pinta: ni el id de la fila, ni el del pedido, ni el `usuarioId` de quien lo hizo.
 */

export interface HistorialDeLaBd {
  estadoAnterior: string | null;
  estadoNuevo: string;
  observacion?: string | null;
  usuarioNombre?: string | null;
  createdAt: Date;
}

/**
 * La misma forma que el historial del personal (la pantalla pinta los mismos 5 campos), pero `observacion` es la FRASE
 * del hito y `usuarioNombre` va vacío.
 */
export interface HistorialParaCliente {
  estadoAnterior: string | null;
  estadoNuevo: string;
  observacion: string;
  usuarioNombre: string;
  createdAt: Date;
}

/** Cambios que el cliente vería como un paso hacia ATRÁS sin que él haya hecho nada: movimientos internos. */
const ES_VAIVEN_INTERNO = (anterior: string | null, nuevo: string): boolean =>
  (anterior === 'EN_ATENCION' && nuevo === 'REVISADO') || // deshacer la llamada
  (nuevo === 'SOLICITADO' && anterior !== null); // devuelto a la cola de preparación

/** La frase de un cambio de estado, o `null` si no es algo que el cliente deba leer. */
export function fraseDelHito(anterior: string | null, nuevo: string): string | null {
  if (ES_VAIVEN_INTERNO(anterior, nuevo)) return null;
  // El cliente (o la tienda por él) resolvió una propuesta: el pedido sigue su camino.
  if (anterior === 'ESPERANDO_APROBACION' && nuevo !== 'CANCELADO' && nuevo !== 'ESPERANDO_APROBACION') {
    return 'Se confirmaron los cambios de tu pedido';
  }
  switch (nuevo) {
    case 'SOLICITADO':
      return 'Recibimos tu pedido';
    case 'EN_REVISION':
      return anterior === 'SOLICITADO' || anterior === null
        ? 'Empezamos a preparar tu pedido'
        : 'Tu pedido volvió a preparación para aplicar los cambios';
    case 'ESPERANDO_APROBACION':
      return anterior === 'EN_ASESORIA'
        ? 'Tu asesor te envió una propuesta'
        : 'Te enviamos una propuesta para que decidas';
    case 'EN_ASESORIA':
      return 'Un asesor de ventas empezó a atenderte';
    case 'EN_DTF':
      return 'Empezamos la impresión de tu DTF';
    case 'REVISADO':
      return 'Tu pedido quedó listo en tienda';
    case 'EN_ATENCION':
      return 'Te llamaron a mostrador';
    case 'PENDIENTE_PAGO':
      return 'Tu pedido pasó a pago';
    case 'PAGADO':
      return 'Recibimos tu pago';
    case 'ENVIADO':
      return 'Tu pedido salió a envío';
    case 'ENTREGADO':
      return 'Pedido entregado';
    case 'CANCELADO':
      return 'Pedido cancelado';
    default:
      return null;
  }
}

export function historialParaCliente<T extends HistorialDeLaBd>(
  filas: readonly T[],
): HistorialParaCliente[] {
  const salida: HistorialParaCliente[] = [];
  for (const h of filas) {
    // Un movimiento del mismo estado es operativo, no un hito.
    if (h.estadoAnterior != null && h.estadoAnterior === h.estadoNuevo) continue;
    const frase = fraseDelHito(h.estadoAnterior ?? null, h.estadoNuevo);
    if (!frase) continue;
    // Dos frases iguales seguidas (por un doble cambio de estado interno) se cuentan una sola vez.
    if (salida.length > 0 && salida[salida.length - 1].observacion === frase) continue;
    salida.push({
      estadoAnterior: h.estadoAnterior ?? null,
      estadoNuevo: h.estadoNuevo,
      observacion: frase,
      usuarioNombre: '',
      createdAt: h.createdAt,
    });
  }
  return salida;
}
