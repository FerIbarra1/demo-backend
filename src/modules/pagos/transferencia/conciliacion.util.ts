/**
 * Utilidades puras del reporte de conciliación de transferencias.
 *
 * Para qué sirve el reporte: la nube no sabe CÓMO registró VFP un cobro (solo que `FINALIZADA`), así
 * que no puede detectar "Tesorería verificó una transferencia pero la tienda la registró como
 * efectivo". El cruce es humano: este reporte lista cada pago verificado con su folio de VFP, monto,
 * referencia y fecha para compararlo contra el corte de caja de VFP.
 *
 * Todo aquí es puro (sin Prisma ni Nest) para poder probarlo: el rango de fechas por zona horaria y
 * el CSV son lo que más fácil se rompe en silencio.
 */

/** Una fila del reporte, ya con los datos listos para mostrar. */
export interface FilaConciliacion {
  verificadoAt: Date | null;
  abonoFecha: Date | null;
  aplicadoAt: Date | null;
  tienda: string;
  folioWeb: string;
  folioVfp: string | null;
  cliente: string;
  referencia: string;
  claveRastreo: string | null;
  /** Decimales como texto: nunca se pasan por `number` (es dinero). */
  montoEsperado: string;
  montoVerificado: string | null;
  estado: string;
  verificadoPor: string | null;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es una fecha `YYYY-MM-DD` que existe en el calendario (no 2026-02-31)? */
export function esFechaYmd(valor: string): boolean {
  const m = YMD.exec(valor);
  if (!m) return false;
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mes - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d;
}

/** Cuántos ms se adelanta la hora local de `zona` respecto a UTC en el instante `fecha`. */
function desfaseMs(fecha: Date, zona: string): number {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(fecha)
      .map((p) => [p.type, p.value]),
  );
  const comoUtc = Date.UTC(
    Number(partes.year),
    Number(partes.month) - 1,
    Number(partes.day),
    Number(partes.hour),
    Number(partes.minute),
    Number(partes.second),
  );
  // `fecha` puede traer milisegundos; la hora local que arma Intl no.
  return comoUtc - Math.floor(fecha.getTime() / 1000) * 1000;
}

/** El instante en que empieza el día `ymd` en la zona `zona` (su medianoche local). */
export function medianocheLocal(ymd: string, zona: string): Date {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`Fecha inválida: ${ymd}`);
  const comoSiFueraUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Dos pasadas: la primera estima el desfase con la hora UTC y la segunda lo corrige si en ese
  // día cambia el horario de verano.
  const primera = comoSiFueraUtc - desfaseMs(new Date(comoSiFueraUtc), zona);
  return new Date(comoSiFueraUtc - desfaseMs(new Date(primera), zona));
}

/** Suma `n` días a una fecha `YYYY-MM-DD` (calendario, sin horas de por medio). */
export function sumarDias(ymd: string, n: number): string {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`Fecha inválida: ${ymd}`);
  const f = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return f.toISOString().slice(0, 10);
}

/** El día de hoy en la zona del negocio, como `YYYY-MM-DD`. */
export function hoyLocal(zona: string, ahora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ahora);
}

/**
 * `[inicio, fin)` de un rango de días del negocio: de la medianoche de `desde` a la medianoche del
 * día SIGUIENTE a `hasta` (así `hasta` queda incluido entero). Las fechas son del negocio, no UTC:
 * un cobro de las 9 p.m. del día 15 en México es del día 15 aunque en UTC ya sea el 16.
 */
export function rangoDeDias(
  desde: string,
  hasta: string,
  zona: string,
): { inicio: Date; fin: Date } {
  return {
    inicio: medianocheLocal(desde, zona),
    fin: medianocheLocal(sumarDias(hasta, 1), zona),
  };
}

/** `2026-10-16 15:30` en la zona del negocio (formato que Excel ordena y entiende). */
export function fechaCsv(fecha: Date | null, zona: string): string {
  if (!fecha) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(fecha);
}

/**
 * Texto seguro para una celda de CSV. Excel y Sheets interpretan como FÓRMULA lo que empieza con
 * `= + - @` (o tab / retorno): el nombre de un cliente así podría ejecutar algo al abrir el
 * reporte. Se antepone una comilla, que Excel muestra como texto. Solo se aplica a texto libre;
 * montos y fechas son datos propios y no pasan por aquí.
 */
export function celdaSegura(valor: string | null | undefined): string {
  const texto = valor ?? '';
  return /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
}

function escapar(celda: string): string {
  return /[",\r\n]/.test(celda) ? `"${celda.replace(/"/g, '""')}"` : celda;
}

export const COLUMNAS_CSV = [
  'Verificada',
  'Abono reflejado',
  'Registrada en el Sistema Comercial',
  'Tienda',
  'Folio web',
  'Folio Sistema Comercial',
  'Cliente',
  'Referencia',
  'Clave de rastreo',
  'Monto esperado',
  'Monto verificado',
  'Estado',
  'Verificó',
] as const;

/**
 * El reporte como CSV para Excel: con BOM (si no, los acentos salen rotos), separador `,` y
 * saltos CRLF. Los montos van sin símbolo ni separador de miles para que sean números.
 */
export function construirCsv(filas: FilaConciliacion[], zona: string): string {
  const lineas = [COLUMNAS_CSV.join(',')];
  for (const f of filas) {
    lineas.push(
      [
        fechaCsv(f.verificadoAt, zona),
        fechaCsv(f.abonoFecha, zona),
        fechaCsv(f.aplicadoAt, zona),
        celdaSegura(f.tienda),
        celdaSegura(f.folioWeb),
        celdaSegura(f.folioVfp),
        celdaSegura(f.cliente),
        celdaSegura(f.referencia),
        celdaSegura(f.claveRastreo),
        f.montoEsperado,
        f.montoVerificado ?? '',
        f.estado,
        celdaSegura(f.verificadoPor),
      ]
        .map(escapar)
        .join(','),
    );
  }
  return `﻿${lineas.join('\r\n')}\r\n`;
}
