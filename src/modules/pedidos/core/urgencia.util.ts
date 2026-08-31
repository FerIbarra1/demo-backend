/**
 * Helpers de urgencia del monitor (bodega y cajero). Compartidos para no
 * duplicar la lógica de cálculo de minutos y nivel de urgencia.
 */

/** Minutos transcurridos entre dos fechas (redondeado hacia abajo). */
export function minutosEntre(desde: Date, hasta: Date): number {
  return Math.floor((hasta.getTime() - desde.getTime()) / 60000);
}

/**
 * Nivel de urgencia según minutos transcurridos y umbrales.
 * 0=normal · 1=aviso · 2=alerta · 3=crítico
 */
export function calcularUrgencia(minutos: number, umbrales: number[]): number {
  if (minutos >= umbrales[2]) return 3;
  if (minutos >= umbrales[1]) return 2;
  if (minutos >= umbrales[0]) return 1;
  return 0;
}
