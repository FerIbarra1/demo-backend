import { EstadoPedido } from '@prisma/client';

/**
 * F12 (sep 2026): reloj de atención del bodeguero.
 *
 * La urgencia de un pedido mide cuánto tiempo lleva en MANOS del bodeguero,
 * no el tiempo total desde que se creó. El reloj se PAUSA mientras la pelota
 * está del lado del cliente (WAITING_CUSTOMER_APPROVAL) y se REANUDA cuando
 * el cliente responde y vuelve a ser tarea del bodeguero.
 *
 * Persistencia en Pedido:
 *   - tiempoAtencionBodegaMs: tiempo acumulado en manos del bodeguero (ms).
 *   - bodegaTurnoDesdeAt: cuándo empezó el turno actual del bodeguero.
 *     NULL = el reloj está pausado (esperando al cliente).
 *
 * El tiempo "en manos del bodeguero" en un instante T es:
 *   tiempoAtencionBodegaMs + (bodegaTurnoDesdeAt ? T - bodegaTurnoDesdeAt : 0)
 */

export interface RelojAtencion {
  tiempoAtencionBodegaMs: number;
  bodegaTurnoDesdeAt: Date | null;
}

/**
 * Calcula el tiempo de atención del bodeguero en un instante dado.
 * Devuelve ms. Si el reloj está pausado (bodegaTurnoDesdeAt null), devuelve
 * el acumulado sin sumar nada.
 */
export function tiempoAtencionEn(reloj: RelojAtencion, ahora: Date): number {
  const acumulado = reloj.tiempoAtencionBodegaMs;
  if (!reloj.bodegaTurnoDesdeAt) return acumulado;
  const delta = ahora.getTime() - reloj.bodegaTurnoDesdeAt.getTime();
  return acumulado + Math.max(0, delta);
}

/**
 * Pausa el reloj: congela el acumulado y limpia bodegaTurnoDesdeAt.
 * Se llama al pasar a WAITING_CUSTOMER_APPROVAL (la pelota es del cliente).
 */
export function pausarReloj(reloj: RelojAtencion, ahora: Date): RelojAtencion {
  return {
    tiempoAtencionBodegaMs: tiempoAtencionEn(reloj, ahora),
    bodegaTurnoDesdeAt: null,
  };
}

/**
 * Reanuda el reloj: mantiene el acumulado y marca el inicio del nuevo turno.
 * Se llama cuando el cliente responde y el pedido vuelve a REVIEWING.
 */
export function reanudarReloj(reloj: RelojAtencion, ahora: Date): RelojAtencion {
  return {
    tiempoAtencionBodegaMs: reloj.tiempoAtencionBodegaMs,
    bodegaTurnoDesdeAt: ahora,
  };
}

/**
 * Estados en los que el reloj de atención está CORRIENDO (es tarea del
 * bodeguero). En cualquier otro estado (WAITING_CUSTOMER_APPROVAL, o ya
 * fuera de bodega) el reloj está pausado o detenido.
 */
export function relojCorreEn(estado: EstadoPedido): boolean {
  return estado === EstadoPedido.PENDING_REVIEW || estado === EstadoPedido.REVIEWING;
}
