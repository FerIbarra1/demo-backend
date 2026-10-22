import { EstadoPreflight } from '@prisma/client';
import { cmCobrados, redondearCm, subtotalDtf, metrosCobrados } from './dtf-cotizador.util';

/**
 * Impresión DTF — el SEMÁFORO de la revisión automática. Ver PLAN-DTF.md §7.4 y D8.
 *
 * El motor (`preflight/`) solo MIDE el archivo; esta función decide qué significan las mediciones para
 * un tipo de DTF concreto. Se separan a propósito: medir toca archivos y procesos hijos, decidir es
 * una función pura que se prueba con una tabla.
 *
 * La revisión AVISA, no decide ("que lo manden no significa que esté bien", y tampoco que esté mal):
 *   · BLOQUEA solo lo objetivo y barato de comprobar: formato, páginas, scripts/cifrado, ancho y
 *     alto máximo. El cliente no puede ni agregarlo al pedido.
 *   · AVISA lo que depende de criterio: fondo, resolución, color, letra chica, transparencias. El
 *     cliente puede seguir (queda registrado) y Impresión tiene la última palabra.
 *   · INFORMA lo demás (medidas, ahorro sugerido).
 */
export type SeveridadRegla = 'OK' | 'AVISO' | 'BLOQUEA' | 'INFO';

export interface ReglaPreflight {
  id: string;
  severidad: SeveridadRegla;
  titulo: string;
  detalle: string;
}

/** Lo que mide el motor sobre un archivo. `null` = no se pudo medir (no es lo mismo que "está bien"). */
export interface Mediciones {
  formato: 'pdf' | 'png' | 'desconocido';
  paginas: number;
  anchoCm: number | null;
  altoCm: number | null;
  /** PNG sin resolución en sus metadatos: el tamaño se calculó asumiendo 300 dpi. */
  dpiAsumido: boolean;
  /** Número de imágenes raster colocadas (0 = el PDF es vectorial). */
  imagenes: number;
  /** El menor ppi efectivo entre las imágenes (píxeles ÷ tamaño colocado). */
  dpiEfectivoMin: number | null;
  modoColor: 'CMYK' | 'RGB' | 'MIXTO' | 'GRIS' | 'DESCONOCIDO';
  /** Fondo opaco que cubre el borde: la máquina lo imprimiría. `null` = sin fondo. */
  fondo: 'BLANCO' | 'COLOR' | null;
  /** Proporción 0..1 de píxeles parcialmente transparentes (sombras, degradados con alfa). */
  semitransparente: number | null;
  /** Caja del contenido visible, normalizada 0..1 (y desde arriba). */
  contenido: { x0: number; y0: number; x1: number; y1: number } | null;
  hayTexto: boolean;
  textoMinPt: number | null;
  seguridad: { javascript: boolean; adjuntos: boolean; cifrado: boolean };
}

/** Reglas del tipo de DTF (salen de `DtfTipo`, nunca hardcodeadas aquí). */
export interface ParametrosTipo {
  anchoUtilCm: number;
  toleranciaAnchoCm: number;
  minimoCm: number;
  maxAlturaCm: number;
  dpiMinimo: number;
  textoMinPt: number;
  pasoCobroCm: number;
  precioMetro: number | null;
}

export interface ResultadoPreflight {
  estado: EstadoPreflight;
  reglas: ReglaPreflight[];
  /** Hay algo que impide agregarlo al pedido. */
  bloquea: boolean;
  avisos: number;
}

const DPI_MUY_BAJO = 150;
/** Por encima de esta proporción de píxeles semitransparentes se avisa de posibles halos blancos. */
const UMBRAL_SEMITRANSPARENTE = 0.12;
/** Margen que se deja al recortar el lienzo al contenido para sugerir el ahorro. */
const MARGEN_AHORRO_CM = 2;

const fmt = (n: number, d = 1) => n.toFixed(d).replace(/\.0+$/, '');

export function evaluarPreflight(m: Mediciones, t: ParametrosTipo): ResultadoPreflight {
  const reglas: ReglaPreflight[] = [];
  const r = (id: string, severidad: SeveridadRegla, titulo: string, detalle: string) =>
    reglas.push({ id, severidad, titulo, detalle });

  // 1. Formato. Solo PDF y PNG (por firma binaria, no por la extensión).
  if (m.formato === 'desconocido') {
    r('formato', 'BLOQUEA', 'Formato no válido', 'Solo recibimos archivos PDF o PNG.');
  } else {
    r('formato', 'OK', 'Formato', m.formato === 'pdf' ? 'PDF' : 'PNG');
  }

  // 2. Seguridad: un PDF con scripts, archivos embebidos o contraseña no se procesa.
  const insegura = m.seguridad.javascript || m.seguridad.adjuntos || m.seguridad.cifrado;
  if (insegura) {
    const que = [
      m.seguridad.javascript && 'scripts',
      m.seguridad.adjuntos && 'archivos adjuntos',
      m.seguridad.cifrado && 'contraseña',
    ]
      .filter(Boolean)
      .join(', ');
    r(
      'seguridad',
      'BLOQUEA',
      'El PDF no es estándar',
      `Trae ${que}. Expórtalo de nuevo como un PDF normal, sin protección.`,
    );
  }

  // 3. Una sola página por archivo.
  if (m.formato === 'pdf' && m.paginas > 1) {
    r(
      'paginas',
      'BLOQUEA',
      'Tiene más de una página',
      `El PDF tiene ${m.paginas} páginas. Cada archivo debe tener una sola; sube cada diseño por separado.`,
    );
  }

  // 4. Ancho: la máquina imprime a 57 cm.
  if (m.anchoCm == null) {
    r('ancho', 'AVISO', 'No pudimos medir el ancho', 'Lo revisará una persona.');
  } else {
    const dif = Math.abs(m.anchoCm - t.anchoUtilCm);
    if (dif > t.toleranciaAnchoCm) {
      if (m.dpiAsumido) {
        r(
          'ancho',
          'AVISO',
          'Revisa el ancho',
          `Tu PNG no trae su resolución; asumiendo 300 dpi mide ${fmt(m.anchoCm)} cm de ancho y debe medir ${fmt(t.anchoUtilCm)} cm. ` +
            'Expórtalo en tamaño real con su resolución.',
        );
      } else {
        r(
          'ancho',
          'BLOQUEA',
          'El ancho no es el correcto',
          `Mide ${fmt(m.anchoCm)} cm de ancho y debe medir ${fmt(t.anchoUtilCm)} cm (tamaño real).`,
        );
      }
    } else {
      r('ancho', 'OK', 'Ancho', `${fmt(m.anchoCm)} cm`);
    }
  }

  // 5. Alto: mínimo (se cobra el mínimo) y máximo por archivo.
  if (m.altoCm != null) {
    const alto = redondearCm(m.altoCm);
    if (alto > t.maxAlturaCm) {
      r(
        'alto',
        'BLOQUEA',
        'Es demasiado largo',
        `Mide ${fmt(alto)} cm de alto y el máximo por archivo es ${fmt(t.maxAlturaCm, 0)} cm. Divídelo en varios archivos.`,
      );
    } else if (alto < t.minimoCm) {
      r(
        'alto',
        'AVISO',
        'Es más corto que el mínimo',
        `Mide ${fmt(alto)} cm de alto; se cobra el mínimo de ${fmt(t.minimoCm, 0)} cm.`,
      );
    } else {
      r('alto', 'OK', 'Alto', `${fmt(alto)} cm`);
    }
  }

  // 6. Fondo.
  if (m.fondo === 'BLANCO') {
    r(
      'fondo',
      'AVISO',
      'Tiene fondo blanco',
      'La máquina imprimiría el fondo. Expórtalo con fondo transparente.',
    );
  } else if (m.fondo === 'COLOR') {
    r(
      'fondo',
      'AVISO',
      'Tiene un fondo de color',
      'La máquina imprimiría el fondo completo. Si no lo quieres, expórtalo con fondo transparente.',
    );
  } else if (m.formato !== 'desconocido' && !insegura) {
    r('fondo', 'OK', 'Sin fondo', 'El fondo es transparente.');
  }

  // 7. Semitransparencias.
  if (m.semitransparente != null && m.semitransparente > UMBRAL_SEMITRANSPARENTE) {
    r(
      'transparencias',
      'AVISO',
      'Sombras o degradados con transparencia',
      'Pueden dejar halos blancos al imprimir. Conviértelos en color sólido si puedes.',
    );
  }

  // 8. Resolución efectiva.
  if (m.formato === 'pdf' && m.imagenes === 0 && !insegura) {
    r('resolucion', 'OK', 'Resolución', 'Vectorial: no pierde calidad al imprimir.');
  } else if (m.dpiEfectivoMin != null) {
    const dpi = Math.round(m.dpiEfectivoMin);
    if (dpi < DPI_MUY_BAJO) {
      r(
        'resolucion',
        'AVISO',
        'Resolución muy baja',
        `Una imagen tiene ${dpi} ppi efectivos y se verá pixelada. Necesitamos ${t.dpiMinimo} en tamaño real.`,
      );
    } else if (dpi < t.dpiMinimo - 5) {
      r(
        'resolucion',
        'AVISO',
        'Resolución baja',
        `Una imagen tiene ${dpi} ppi efectivos (recomendado ${t.dpiMinimo}).`,
      );
    } else {
      r('resolucion', 'OK', 'Resolución', `${dpi} ppi`);
    }
  }

  // 9. Letra chica.
  if (m.hayTexto && m.textoMinPt != null) {
    if (m.textoMinPt < t.textoMinPt) {
      r(
        'texto',
        'AVISO',
        'Letra muy chica',
        `Hay texto de ${fmt(m.textoMinPt)} pt; debajo de ${fmt(t.textoMinPt)} pt suele desaparecer al imprimir.`,
      );
    } else {
      r('texto', 'OK', 'Texto', `Desde ${fmt(m.textoMinPt)} pt`);
    }
  }

  // 10. Modo de color. En PNG es siempre RGB: no se le reprocha.
  if (m.formato === 'pdf') {
    if (m.modoColor === 'CMYK') r('color', 'OK', 'Color', 'CMYK');
    else if (m.modoColor === 'RGB' || m.modoColor === 'MIXTO') {
      r(
        'color',
        'AVISO',
        m.modoColor === 'RGB' ? 'Está en RGB' : 'Mezcla RGB y CMYK',
        'Los colores pueden cambiar al convertirlos a CMYK para imprimir.',
      );
    }
  }

  // 11. Ahorro sugerido: el lienzo es mucho más largo que el diseño y se cobra por película.
  if (m.contenido && m.altoCm != null && t.precioMetro != null && m.altoCm >= t.minimoCm) {
    const altoContenidoCm = (m.contenido.y1 - m.contenido.y0) * m.altoCm + MARGEN_AHORRO_CM;
    const reglasCobro = { minimoCm: t.minimoCm, pasoCobroCm: t.pasoCobroCm };
    const hoy = cmCobrados(m.altoCm, reglasCobro);
    const recortado = cmCobrados(altoContenidoCm, reglasCobro);
    if (hoy - recortado >= t.pasoCobroCm) {
      const ahorro = subtotalDtf(
        metrosCobrados(hoy, 1, reglasCobro).minus(metrosCobrados(recortado, 1, reglasCobro)),
        t.precioMetro,
      );
      r(
        'ahorro',
        'INFO',
        'Podrías ahorrar',
        `Tu diseño ocupa unos ${fmt(altoContenidoCm - MARGEN_AHORRO_CM, 0)} cm de los ${fmt(m.altoCm, 0)} cm de alto. ` +
          `Si recortas el archivo a ${fmt(altoContenidoCm, 0)} cm ahorras $${ahorro.toString()}.`,
      );
    }
  }

  const bloquea = reglas.some((x) => x.severidad === 'BLOQUEA');
  const avisos = reglas.filter((x) => x.severidad === 'AVISO').length;
  return {
    estado: bloquea
      ? EstadoPreflight.BLOQUEADO
      : avisos > 0
        ? EstadoPreflight.CON_AVISOS
        : EstadoPreflight.OK,
    reglas,
    bloquea,
    avisos,
  };
}

/** El análisis falló o se agotó el tiempo: NO bloquea, lo revisa una persona (D8). */
export function preflightNoConcluyente(motivo: string): ResultadoPreflight {
  return {
    estado: EstadoPreflight.NO_CONCLUYENTE,
    reglas: [
      {
        id: 'analisis',
        severidad: 'AVISO',
        titulo: 'No pudimos revisarlo automáticamente',
        detalle: `${motivo} Una persona de Impresión lo revisará.`,
      },
    ],
    bloquea: false,
    avisos: 1,
  };
}
