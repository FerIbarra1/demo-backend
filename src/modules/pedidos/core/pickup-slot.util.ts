/**
 * F8 (jul 2026): helper que valida si una fecha+hora cae en un slot válido de
 * recogida en tienda. La lógica DEBE ser idéntica a la del frontend
 * (`src/lib/utils/pickupSlots.ts` en demo-frontend) para que el backend pueda
 * rechazar slots inválidos como defensa en profundidad.
 *
 * Reglas (estáticas, no dinámicas por tienda):
 * - Lunes a Viernes: 9:30 a 18:00 (último slot inicia 17:30).
 * - Sábado:           9:00 a 14:30 (último slot inicia 14:00).
 * - Domingo:          cerrado.
 * - Granularidad:     30 minutos exactos.
 * - Margen:           el slot no puede iniciar antes de `now + 30 min` para
 *                     darle tiempo al cliente de prepararse.
 *
 * Zona horaria: explícitamente la del negocio (`America/Mazatlan`). Si se
 * cambia el huso horario del negocio, actualizar este archivo Y el util del
 * frontend, y nunca depender de la zona del contenedor/server.
 */
const TIMEZONE = 'America/Mazatlan';

const MS_PER_MIN = 60_000;

/** Minutos desde medianoche local + día de la semana (0=Dom..6=Sáb). */
function localMinutes(date: Date): { mins: number; weekday: number } {
  // Obtenemos los componentes en la zona horaria del negocio.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl devuelve weekday como "Mon", "Tue", etc. Mapeamos a 0-6 (Dom=0).
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  return { mins: hour * 60 + minute, weekday: weekdayMap[weekdayStr] ?? 0 };
}

/** Devuelve true si `date` cae en un slot válido de recogida. */
export function isValidPickupSlot(date: Date, now: Date = new Date()): boolean {
  const { mins, weekday } = localMinutes(date);

  // 1) Domingo cerrado.
  if (weekday === 0) return false;

  // 2) Sábado: 9:00-14:00 inclusive (slots de 30 min, último cierra 14:30).
  if (weekday === 6) {
    if (mins < 9 * 60 || mins > 14 * 60) return false;
  } else {
    // 3) Lun-Vie: 9:30-17:30 inclusive (último cierra 18:00).
    if (mins < 9 * 60 + 30 || mins > 17 * 60 + 30) return false;
  }

  // 4) Granularidad: minutos múltiplos de 30.
  if (mins % 30 !== 0) return false;

  // 5) Margen: slot debe iniciar al menos 30 min en el futuro (en zona local).
  //    Construimos la fecha "slot inicia" en zona local y comparamos con now.
  const slotLocal = new Date(date);
  // Truco: restamos el offset TZ para quedarnos en UTC comparable.
  const offsetMin = tzOffsetMinutes(slotLocal);
  const slotUtcAdjusted = new Date(slotLocal.getTime() - offsetMin * MS_PER_MIN);
  const marginOk = slotUtcAdjusted.getTime() >= now.getTime() + 30 * MS_PER_MIN;
  return marginOk;
}

/** Offset en minutos de `date` respecto a UTC, en la zona del negocio. */
function tzOffsetMinutes(date: Date): number {
  const localStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  // localStr = "2026-07-09, 09:30:00" → lo tratamos como si fuera UTC y vemos
  // la diferencia con la fecha original.
  const [datePart, timePart] = localStr.split(', ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  return Math.round((asUtc - date.getTime()) / MS_PER_MIN);
}
