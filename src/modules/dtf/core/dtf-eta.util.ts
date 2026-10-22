/**
 * Impresión DTF — hora estimada de entrega. Reemplaza la columna HORA del Excel (que alguien calculaba
 * a ojo según la cola). Ver PLAN-DTF.md §8.4.
 *
 *   hora = ahora + (metros por delante en la cola + los de este trabajo) ÷ velocidad (m/h) + holgura
 *
 * Es una ESTIMACIÓN y Impresión puede ajustarla (queda en la bitácora). Sin velocidad configurada no
 * se inventa una hora: devuelve `null` y la pantalla no promete nada.
 */
export interface EntradaEta {
  ahora: Date;
  /** Metros de los trabajos aprobados/imprimiéndose que van antes, en la misma tecnología. */
  metrosPorDelante: number;
  /** Metros de ESTE trabajo. */
  metros: number;
  velocidadMetrosHora: number | null;
  /** Holgura fija (preparar, cortar, empacar). */
  holguraMin?: number;
}

export function estimarHoraEntrega(e: EntradaEta): Date | null {
  const v = e.velocidadMetrosHora;
  if (!v || v <= 0) return null;
  const metros = Math.max(0, e.metrosPorDelante) + Math.max(0, e.metros);
  const minutos = (metros / v) * 60 + (e.holguraMin ?? 10);
  // Se redondea hacia arriba a 5 minutos: "listo ≈ 2:45", no "2:41:17".
  const redondeados = Math.ceil(minutos / 5) * 5;
  return new Date(e.ahora.getTime() + redondeados * 60_000);
}

/** Hora (0–23) y minuto del día en una zona horaria IANA, sin depender de la zona del servidor. */
export function horaLocal(fecha: Date, zona: string): { h: number; m: number } {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: zona,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(fecha);
  const h = Number(partes.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(partes.find((p) => p.type === 'minute')?.value ?? 0);
  return { h, m };
}

/** ¿Ya pasó la hora de corte ("15:00") en la zona de la tienda? Lo que llega después sale mañana. */
export function pasoLaHoraDeCorte(ahora: Date, horaCorte: string | null, zona: string): boolean {
  if (!horaCorte) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(horaCorte.trim());
  if (!m) return false;
  const corte = Number(m[1]) * 60 + Number(m[2]);
  const { h, m: min } = horaLocal(ahora, zona);
  return h * 60 + min >= corte;
}
