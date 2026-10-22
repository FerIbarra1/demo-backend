/**
 * N1 (PLAN-ADMIN-MULTITIENDA §10, oct 2026): la TORRE DE CONTROL. Lo PURO: qué es "esperar demasiado" y cómo se
 * resume una tienda en un semáforo. Sin Prisma ni Nest, para fijarlo con un spec (`torre-control.util.spec.ts`).
 *
 * Una tienda se pone ámbar o roja por la ESPERA MÁS LARGA de alguna de sus etapas: lo que importa al dirigir la
 * operación no es cuánto hay (30 pedidos en caja pueden ser un buen día) sino cuánto lleva esperando el primero.
 */

export type Nivel = 'verde' | 'ambar' | 'rojo';

/**
 * Etapas en las que alguien espera a que el PERSONAL haga algo. No entran las que esperan al CLIENTE (propuesta por
 * decidir, pedido pagado sin recoger): ese silencio no es un fallo de la tienda.
 */
export const ETAPAS_ESPERA = [
  'bodega', // SOLICITADO, o EN_REVISION sin bodeguero (liberado): nadie lo tiene
  'surtido', // EN_REVISION en manos de un bodeguero
  'ventas', // EN_ASESORIA: el asesor tiene que contestar
  'mostrador', // REVISADO con el cliente YA en tienda esperando
  'caja', // PENDIENTE_PAGO en la fila (sin cajero asignado)
  'transferencias', // transferencia con comprobante por verificar (Tesorería)
  'sinRegistrar', // transferencia verificada que falta registrar en el Sistema Comercial
  'dtf', // trabajo DTF recibido que nadie ha tomado a revisión
] as const;
export type EtapaEspera = (typeof ETAPAS_ESPERA)[number];

export interface Umbral {
  /** Minutos esperando a partir de los cuales la etapa se pone ámbar. */
  ambar: number;
  /** Minutos a partir de los cuales se pone roja. */
  rojo: number;
}

/**
 * Los umbrales, en minutos. Son DECISIÓN DE OPERACIÓN y arrancan como números razonables, no medidos: viven
 * juntos aquí (y no regados por las consultas) para que ajustarlos sea cambiar una tabla. N4 ("Atorados") los
 * generalizará y los hará editables.
 *
 *  - Donde el cliente está de pie (mostrador, caja) la paciencia es corta: 10 / 20.
 *  - Bodega es trabajo físico: 15 / 30 sin tomar y el doble ya en manos de alguien.
 *  - Lo que depende de una persona que revisa a su ritmo (transferencias, DTF) se mide en horas.
 *  - `sinRegistrar` NO está aquí: su umbral sale de `PAGOS_ALERTA_SIN_REGISTRAR_HORAS` (el mismo de Tesorería).
 */
export const UMBRALES_MIN: Record<Exclude<EtapaEspera, 'sinRegistrar'>, Umbral> = {
  bodega: { ambar: 15, rojo: 30 },
  surtido: { ambar: 30, rojo: 60 },
  ventas: { ambar: 30, rojo: 60 },
  mostrador: { ambar: 10, rojo: 20 },
  caja: { ambar: 10, rojo: 20 },
  transferencias: { ambar: 60, rojo: 180 },
  dtf: { ambar: 60, rojo: 180 },
};

/** Umbral de "verificada y sin registrar": el de alerta de Tesorería (horas) y el triple para el rojo. */
export function umbralSinRegistrar(horasDeAlerta: number): Umbral {
  const h = horasDeAlerta > 0 ? horasDeAlerta : 4;
  return { ambar: h * 60, rojo: h * 60 * 3 };
}

export function nivelDeEspera(minutos: number, umbral: Umbral): Nivel {
  if (minutos >= umbral.rojo) return 'rojo';
  if (minutos >= umbral.ambar) return 'ambar';
  return 'verde';
}

const ORDEN: Record<Nivel, number> = { verde: 0, ambar: 1, rojo: 2 };

export function peorNivel(niveles: Nivel[]): Nivel {
  return niveles.reduce<Nivel>((peor, n) => (ORDEN[n] > ORDEN[peor] ? n : peor), 'verde');
}

/** La espera más larga de una etapa: cuánto lleva y de qué pedido (el folio que se ve en pantalla). */
export interface Espera {
  minutos: number;
  referencia: string | null;
}

export interface MotivoSemaforo {
  etapa: EtapaEspera;
  nivel: Exclude<Nivel, 'verde'>;
  minutos: number;
  referencia: string | null;
  texto: string;
}

const NOMBRE_ETAPA: Record<EtapaEspera, string> = {
  bodega: 'Bodega (sin tomar)',
  surtido: 'Bodega (surtiendo)',
  ventas: 'Ventas',
  mostrador: 'Mostrador',
  caja: 'Caja',
  transferencias: 'Transferencias por verificar',
  sinRegistrar: 'Transferencias sin registrar',
  dtf: 'DTF por revisar',
};

/** "24 min", "2 h 5 min", "3 h". */
export function duracionLegible(minutos: number): string {
  const m = Math.max(0, Math.round(minutos));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/**
 * El semáforo de UNA tienda a partir de la espera más larga de cada etapa (`null` = nadie espera ahí).
 * Los `motivos` son solo las etapas que pasaron de verde, de la peor a la menos mala: es lo que la tarjeta
 * lista para que el ADMIN sepa POR QUÉ no es verde sin entrar a ninguna consola.
 */
export function armarSemaforo(
  esperas: Partial<Record<EtapaEspera, Espera | null>>,
  horasDeAlertaSinRegistrar: number,
): { nivel: Nivel; motivos: MotivoSemaforo[] } {
  const motivos: MotivoSemaforo[] = [];
  for (const etapa of ETAPAS_ESPERA) {
    const e = esperas[etapa];
    if (!e) continue;
    const umbral =
      etapa === 'sinRegistrar'
        ? umbralSinRegistrar(horasDeAlertaSinRegistrar)
        : UMBRALES_MIN[etapa];
    const nivel = nivelDeEspera(e.minutos, umbral);
    if (nivel === 'verde') continue;
    motivos.push({
      etapa,
      nivel,
      minutos: e.minutos,
      referencia: e.referencia,
      texto: `${NOMBRE_ETAPA[etapa]}: ${duracionLegible(e.minutos)} esperando${e.referencia ? ` (${e.referencia})` : ''}`,
    });
  }
  motivos.sort((a, b) => ORDEN[b.nivel] - ORDEN[a.nivel] || b.minutos - a.minutos);
  return { nivel: peorNivel(motivos.map((m) => m.nivel)), motivos };
}

/**
 * La espera MÁS larga entre todas las etapas (lo de "lo que más espera" de la tarjeta), aunque no pase de verde:
 * el ADMIN quiere ver "Caja · 6 min" también en una tienda que va bien.
 */
export function esperaMasLarga(
  esperas: Partial<Record<EtapaEspera, Espera | null>>,
): { etapa: EtapaEspera; minutos: number; referencia: string | null } | null {
  let mejor: { etapa: EtapaEspera; minutos: number; referencia: string | null } | null = null;
  for (const etapa of ETAPAS_ESPERA) {
    const e = esperas[etapa];
    if (e && (!mejor || e.minutos > mejor.minutos)) mejor = { etapa, ...e };
  }
  return mejor;
}

/** Minutos enteros entre `desde` y `ahora` (nunca negativos: un reloj adelantado no es una espera). */
export function minutosDesde(desde: Date | null | undefined, ahora: Date): number | null {
  if (!desde) return null;
  return Math.max(0, Math.floor((ahora.getTime() - desde.getTime()) / 60_000));
}

/** De una lista de fechas "desde", la más antigua con su referencia → la `Espera` de la etapa. */
export function esperaDeLaMasVieja(
  filas: Array<{ desde: Date | null; referencia: string | null }>,
  ahora: Date,
): Espera | null {
  let mejor: Espera | null = null;
  for (const f of filas) {
    const m = minutosDesde(f.desde, ahora);
    if (m === null) continue;
    if (!mejor || m > mejor.minutos) mejor = { minutos: m, referencia: f.referencia };
  }
  return mejor;
}
