import {
  duracionLegible,
  nivelDeEspera,
  peorNivel,
  type Nivel,
  type Umbral,
} from './torre-control.util';

/**
 * N3 (PLAN-ADMIN-MULTITIENDA §10, oct 2026): la SALUD del sistema. Lo PURO: cuándo un subsistema está bien, con
 * espera o roto. Sin Prisma ni Nest, para fijarlo con un spec (`salud-sistema.util.spec.ts`).
 *
 * Qué pregunta responde: hoy un pedido atorado hacia el Sistema Comercial NO lo ve nadie hasta que el cliente reclama
 * (es el riesgo operativo más caro: PENDIENTE_PAGO sin folio no se cobra). Aquí se vuelve visible: el agente del ERP
 * por tienda, lo que hay en su bandeja, los eventos de sync fallidos, las tablets, las pantallas y los barridos.
 *
 * Igual que en la torre, los UMBRALES son decisión de operación y NO están medidos: viven juntos para ajustarlos.
 */

export interface MotivoSalud {
  area:
    | 'agente'
    | 'bandeja'
    | 'folios'
    | 'conciliacion'
    | 'eventos'
    | 'kioskos'
    | 'pantallas'
    | 'outbox'
    | 'workers';
  nivel: Exclude<Nivel, 'verde'>;
  texto: string;
}

export const UMBRALES_SALUD = {
  /** Minutos sin latido del agente del ERP. */
  agente: { ambar: 5, rojo: 15 } as Umbral,
  /** Minutos que un pedido lleva en la bandeja (PENDIENTE) sin que el agente lo tome. */
  bandejaSinTomar: { ambar: 5, rojo: 15 } as Umbral,
  /** Minutos que lleva el reintento más viejo (el agente lo intenta y falla). */
  reintento: { ambar: 1, rojo: 30 } as Umbral,
  /**
   * Minutos que un pedido lleva esperando su FOLIO del Sistema Comercial (parte B). El agente contesta en su siguiente
   * ciclo (unos segundos): 2 min ya es raro, y con 10 bodega lleva rato sin poder imprimir el ticket.
   */
  folios: { ambar: 2, rojo: 10 } as Umbral,
  /**
   * Minutos desde la última CONCILIACIÓN (el agente compara la nube contra el Sistema Comercial cada ~10 min). Solo
   * importa con el agente en línea: si no late, el aviso es el del agente.
   */
  conciliacion: { ambar: 30, rojo: 120 } as Umbral,
  /** Minutos sin latido de la TV de bodega (late cada 5). */
  pantalla: { ambar: 10, rojo: 30 } as Umbral,
  /** Minutos que lleva sin emitirse el evento realtime más viejo del outbox (el worker lo drena cada segundo). */
  outbox: { ambar: 2, rojo: 10 } as Umbral,
  /** Un worker se pone ámbar tras 3 periodos sin correr y rojo tras 6, con un piso para los que corren cada segundo. */
  workerAmbarPeriodos: 3,
  workerRojoPeriodos: 6,
  workerPisoAmbarMs: 60_000,
  workerPisoRojoMs: 5 * 60_000,
};

type Resultado = { nivel: Nivel; motivos: Omit<MotivoSalud, 'area'>[] };

const motivo = (nivel: Nivel, texto: string): Omit<MotivoSalud, 'area'>[] =>
  nivel === 'verde' ? [] : [{ nivel, texto }];

// ── agente del ERP (uno por tienda) ─────────────────────────────────────────────────────────────

export type EstadoAgente = 'EN_LINEA' | 'SIN_LATIDO' | 'NUNCA';

/**
 * `minutosSinLatido` null = el agente nunca se ha conectado a esa tienda. Eso solo es un problema si HAY trabajo
 * esperándolo: una tienda sin agente configurado y sin pedidos al ERP no está rota, aún no se instala.
 */
export function evaluarAgente(
  minutosSinLatido: number | null,
  hayTrabajoEnBandeja: boolean,
): { estado: EstadoAgente } & Resultado {
  if (minutosSinLatido === null) {
    return {
      estado: 'NUNCA',
      nivel: hayTrabajoEnBandeja ? 'rojo' : 'verde',
      motivos: motivo(
        hayTrabajoEnBandeja ? 'rojo' : 'verde',
        'El agente del Sistema Comercial nunca se ha conectado y ya hay pedidos esperándolo',
      ),
    };
  }
  const nivel = nivelDeEspera(minutosSinLatido, UMBRALES_SALUD.agente);
  return {
    estado: nivel === 'verde' ? 'EN_LINEA' : 'SIN_LATIDO',
    nivel,
    motivos: motivo(
      nivel,
      `El agente del Sistema Comercial no reporta hace ${duracionLegible(minutosSinLatido)}`,
    ),
  };
}

// ── bandeja nube → ERP (PedidoPendienteEnvio) ───────────────────────────────────────────────────

export interface EntradaBandeja {
  /** Minutos del PENDIENTE más viejo (esperando que el agente lo tome), o null si no hay. */
  pendienteMasViejoMin: number | null;
  /** Folio del pedido más viejo, para el texto. */
  pendienteReferencia: string | null;
  reintentos: number;
  reintentoMasViejoMin: number | null;
  /** PROCESSING con el lease vencido: el agente lo tomó y no terminó (se cayó a medio proceso). */
  leaseVencidos: number;
}

export function evaluarBandeja(b: EntradaBandeja): Resultado {
  const motivos: Omit<MotivoSalud, 'area'>[] = [];
  const niveles: Nivel[] = [];
  if (b.pendienteMasViejoMin !== null) {
    const n = nivelDeEspera(b.pendienteMasViejoMin, UMBRALES_SALUD.bandejaSinTomar);
    niveles.push(n);
    motivos.push(
      ...motivo(
        n,
        `Un pedido lleva ${duracionLegible(b.pendienteMasViejoMin)} en la bandeja sin que el agente lo tome${b.pendienteReferencia ? ` (${b.pendienteReferencia})` : ''}`,
      ),
    );
  }
  if (b.reintentos > 0 && b.reintentoMasViejoMin !== null) {
    const n = nivelDeEspera(b.reintentoMasViejoMin, UMBRALES_SALUD.reintento);
    niveles.push(n);
    motivos.push(
      ...motivo(
        n,
        `${b.reintentos} pedido${b.reintentos === 1 ? '' : 's'} en reintento hacia el Sistema Comercial (el más viejo, ${duracionLegible(b.reintentoMasViejoMin)})`,
      ),
    );
  }
  if (b.leaseVencidos > 0) {
    niveles.push('ambar');
    motivos.push(
      ...motivo(
        'ambar',
        `${b.leaseVencidos} pedido${b.leaseVencidos === 1 ? '' : 's'} que el agente tomó y no terminó (se cayó a medio proceso)`,
      ),
    );
  }
  motivos.sort((a, c) => (a.nivel === c.nivel ? 0 : a.nivel === 'rojo' ? -1 : 1));
  return { nivel: peorNivel(niveles), motivos };
}

// ── folios pedidos al agente (PedidoFolioSolicitud) ─────────────────────────────────────────────

export interface EntradaFolios {
  /** Cuántos pedidos esperan su folio (PENDIENTE o PROCESSING, sin cancelar). */
  sinAsignar: number;
  /** Minutos de la solicitud más vieja, o null si no hay. */
  masViejaMin: number | null;
  /** Folio del pedido más viejo, para el texto. */
  referencia: string | null;
  /** Solicitudes que el agente intentó y no pudo (CONSECUTIVOS ocupado, tienda sin consecutivo…). */
  conError: number;
}

export function evaluarFolios(f: EntradaFolios): Resultado {
  const motivos: Omit<MotivoSalud, 'area'>[] = [];
  const niveles: Nivel[] = [];
  if (f.masViejaMin !== null) {
    const n = nivelDeEspera(f.masViejaMin, UMBRALES_SALUD.folios);
    niveles.push(n);
    motivos.push(
      ...motivo(
        n,
        `${f.sinAsignar} pedido${f.sinAsignar === 1 ? '' : 's'} sin folio del Sistema Comercial (el más viejo, ${duracionLegible(f.masViejaMin)}${f.referencia ? `: ${f.referencia}` : ''}): bodega no puede imprimir su ticket`,
      ),
    );
  }
  if (f.conError > 0) {
    niveles.push('ambar');
    motivos.push(
      ...motivo(
        'ambar',
        `El agente no pudo reservar el folio de ${f.conError} pedido${f.conError === 1 ? '' : 's'} (reintenta cada 30 s)`,
      ),
    );
  }
  motivos.sort((a, c) => (a.nivel === c.nivel ? 0 : a.nivel === 'rojo' ? -1 : 1));
  return { nivel: peorNivel(niveles), motivos };
}

// ── conciliación nube ↔ Sistema Comercial ───────────────────────────────────────────────────────

/** Los hallazgos que tocan DINERO sin respuesta obvia: rojo. Los demás (no existe allá, estados raros) son ámbar. */
const HALLAZGOS_DE_DINERO = ['COBRADO_Y_CANCELADO', 'REVERSA_DE_COBRO', 'TOTAL_DISTINTO'];

export interface EntradaConciliacion {
  /** Minutos desde la última comparación del agente, o null si nunca ha comparado. */
  minutosDesdeUltima: number | null;
  /** El agente reporta (si no, el aviso es el del agente y no se duplica). */
  agenteEnLinea: boolean;
  /** Hallazgos ABIERTOS (los que la nube corrigió sola no cuentan: son constancia, no trabajo). */
  abiertos: Array<{ tipo: string; titulo: string; numeroPedido: string }>;
}

export function evaluarConciliacion(c: EntradaConciliacion): Resultado {
  const motivos: Omit<MotivoSalud, 'area'>[] = [];

  const dinero = c.abiertos.filter((h) => HALLAZGOS_DE_DINERO.includes(h.tipo));
  const otros = c.abiertos.filter((h) => !HALLAZGOS_DE_DINERO.includes(h.tipo));
  const lista = (xs: typeof dinero) =>
    xs
      .slice(0, 3)
      .map((h) => h.numeroPedido)
      .join(', ') + (xs.length > 3 ? '…' : '');
  if (dinero.length > 0) {
    motivos.push(
      ...motivo(
        'rojo',
        `${dinero.length} pedido${dinero.length === 1 ? '' : 's'} con dinero que no coincide con el Sistema Comercial (${lista(dinero)})`,
      ),
    );
  }
  if (otros.length > 0) {
    motivos.push(
      ...motivo(
        'ambar',
        `${otros.length} pedido${otros.length === 1 ? '' : 's'} que no cuadra${otros.length === 1 ? '' : 'n'} con el Sistema Comercial (${lista(otros)})`,
      ),
    );
  }

  // Que nadie compare es una falta de verificación, no una diferencia: se avisa solo con el agente vivo.
  if (c.agenteEnLinea) {
    if (c.minutosDesdeUltima === null) {
      motivos.push(
        ...motivo(
          'ambar',
          'El agente aún no compara los pedidos contra el Sistema Comercial (¿versión anterior del agente?)',
        ),
      );
    } else {
      const n = nivelDeEspera(c.minutosDesdeUltima, UMBRALES_SALUD.conciliacion);
      motivos.push(
        ...motivo(
          n,
          `La última comparación con el Sistema Comercial fue hace ${duracionLegible(c.minutosDesdeUltima)}`,
        ),
      );
    }
  }

  motivos.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'rojo' ? -1 : 1));
  return { nivel: peorNivel(motivos.map((m) => m.nivel)), motivos };
}

// ── eventos de sync (ERP → nube) ────────────────────────────────────────────────────────────────

/** Un evento muerto (DEAD_LETTER) ya no se reintenta solo: hay que mirarlo. Uno en ERROR todavía se reintenta. */
export function evaluarEventos(e: { error: number; muertos: number }): Resultado {
  const motivos: Omit<MotivoSalud, 'area'>[] = [];
  if (e.muertos > 0)
    motivos.push(
      ...motivo(
        'rojo',
        `${e.muertos} evento${e.muertos === 1 ? '' : 's'} de sincronización muerto${e.muertos === 1 ? '' : 's'} (ya no se reintenta solo)`,
      ),
    );
  if (e.error > 0)
    motivos.push(
      ...motivo(
        'ambar',
        `${e.error} evento${e.error === 1 ? '' : 's'} de sincronización con error (se reintenta)`,
      ),
    );
  return { nivel: e.muertos > 0 ? 'rojo' : e.error > 0 ? 'ambar' : 'verde', motivos };
}

// ── kioskos y pantallas ─────────────────────────────────────────────────────────────────────────

/** `activos` = los que DEBERÍAN estar latiendo (activos y con credencial). Todos caídos es una tienda sin kiosko. */
export function evaluarKioskos(k: {
  activos: number;
  caidos: number;
  sinCredencial: number;
}): Resultado {
  const motivos: Omit<MotivoSalud, 'area'>[] = [];
  const todos = k.activos > 0 && k.caidos >= k.activos;
  if (k.caidos > 0) {
    motivos.push(
      ...motivo(
        todos ? 'rojo' : 'ambar',
        `${k.caidos} kiosko${k.caidos === 1 ? '' : 's'} sin conexión${todos ? ' (ninguno responde)' : ''}`,
      ),
    );
  }
  if (k.sinCredencial > 0) {
    motivos.push(
      ...motivo(
        'ambar',
        `${k.sinCredencial} kiosko${k.sinCredencial === 1 ? '' : 's'} sin credencial (hay que volver a vincular la tablet)`,
      ),
    );
  }
  return { nivel: peorNivel(motivos.map((m) => m.nivel)), motivos };
}

export function evaluarPantalla(minutosSinLatido: number | null): {
  nivel: Nivel;
  enLinea: boolean;
} {
  // Nunca ha latido: la pantalla no se instaló o no reporta. No es una falla que alarmar.
  if (minutosSinLatido === null) return { nivel: 'verde', enLinea: false };
  const nivel = nivelDeEspera(minutosSinLatido, UMBRALES_SALUD.pantalla);
  return { nivel, enLinea: nivel === 'verde' };
}

// ── outbox de realtime y workers ────────────────────────────────────────────────────────────────

export function evaluarOutbox(o: { sinEmitir: number; masViejoMin: number | null }): Resultado {
  if (o.sinEmitir === 0 || o.masViejoMin === null) return { nivel: 'verde', motivos: [] };
  const nivel = nivelDeEspera(o.masViejoMin, UMBRALES_SALUD.outbox);
  return {
    nivel,
    motivos: motivo(
      nivel,
      `${o.sinEmitir} evento${o.sinEmitir === 1 ? '' : 's'} en vivo sin emitir, el más viejo hace ${duracionLegible(o.masViejoMin)} (el barrido del outbox no los está drenando)`,
    ),
  };
}

export interface EntradaWorkerSalud {
  nombre: string;
  periodoMs: number;
  declaradoAt: Date;
  ultimaCorridaAt: Date | null;
  ultimoError: string | null;
  ultimoErrorAt: Date | null;
}

/**
 * Un worker está sano si corrió dentro de unos cuantos periodos. Se cuenta desde la última corrida o, si aún no ha
 * corrido, desde que se DECLARÓ (un reinicio reciente no lo pone rojo: le falta tiempo, no está roto).
 */
export function evaluarWorker(
  w: EntradaWorkerSalud,
  ahora: Date,
): Resultado & { minutosDesdeCorrida: number } {
  const referencia = w.ultimaCorridaAt ?? w.declaradoAt;
  const atrasoMs = Math.max(0, ahora.getTime() - referencia.getTime());
  const ambarMs = Math.max(
    w.periodoMs * UMBRALES_SALUD.workerAmbarPeriodos,
    UMBRALES_SALUD.workerPisoAmbarMs,
  );
  const rojoMs = Math.max(
    w.periodoMs * UMBRALES_SALUD.workerRojoPeriodos,
    UMBRALES_SALUD.workerPisoRojoMs,
  );
  const nivel: Nivel = atrasoMs >= rojoMs ? 'rojo' : atrasoMs >= ambarMs ? 'ambar' : 'verde';
  const minutos = Math.floor(atrasoMs / 60_000);
  // Falló en su último intento (el error es más reciente que la última corrida buena): ámbar aunque aún esté a tiempo.
  const fallando = !!w.ultimoErrorAt && (!w.ultimaCorridaAt || w.ultimoErrorAt > w.ultimaCorridaAt);
  const final: Nivel = nivel === 'verde' && fallando ? 'ambar' : nivel;
  return {
    nivel: final,
    minutosDesdeCorrida: minutos,
    motivos: motivo(
      final,
      fallando
        ? `El barrido «${w.nombre}» está fallando: ${w.ultimoError ?? 'error sin mensaje'}`
        : `El barrido «${w.nombre}» no corre hace ${duracionLegible(minutos)}`,
    ),
  };
}

/** El peor nivel de una lista de resultados. */
export function peorDe(...niveles: Nivel[]): Nivel {
  return peorNivel(niveles);
}
