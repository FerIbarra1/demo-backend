import { EstadoPreflight } from '@prisma/client';
import {
  evaluarPreflight,
  Mediciones,
  ParametrosTipo,
  preflightNoConcluyente,
} from './dtf-reglas.util';

const TEXTIL: ParametrosTipo = {
  anchoUtilCm: 57,
  toleranciaAnchoCm: 0.5,
  minimoCm: 50,
  maxAlturaCm: 250,
  dpiMinimo: 300,
  textoMinPt: 6,
  pasoCobroCm: 50,
  precioMetro: 220,
};

/** Un archivo perfecto: vectorial, 57 × 100 cm, sin fondo, CMYK, texto de 24 pt. */
const bueno = (): Mediciones => ({
  formato: 'pdf',
  paginas: 1,
  anchoCm: 57,
  altoCm: 100,
  dpiAsumido: false,
  imagenes: 0,
  dpiEfectivoMin: null,
  modoColor: 'CMYK',
  fondo: null,
  semitransparente: 0.01,
  contenido: { x0: 0, y0: 0, x1: 1, y1: 0.98 },
  hayTexto: true,
  textoMinPt: 24,
  seguridad: { javascript: false, adjuntos: false, cifrado: false },
});

const regla = (m: Mediciones, id: string, t = TEXTIL) =>
  evaluarPreflight(m, t).reglas.find((x) => x.id === id);

describe('semáforo de la revisión automática', () => {
  it('un archivo bien hecho sale OK, sin avisos ni bloqueos', () => {
    const r = evaluarPreflight(bueno(), TEXTIL);
    expect(r.estado).toBe(EstadoPreflight.OK);
    expect(r.bloquea).toBe(false);
    expect(r.avisos).toBe(0);
  });

  describe('lo que BLOQUEA (objetivo y barato)', () => {
    it.each([
      ['formato desconocido', { formato: 'desconocido' as const }, 'formato'],
      ['más de una página', { paginas: 3 }, 'paginas'],
      ['ancho de 61 cm', { anchoCm: 61 }, 'ancho'],
      ['más de 250 cm de alto', { altoCm: 260 }, 'alto'],
      [
        'PDF con scripts',
        { seguridad: { javascript: true, adjuntos: false, cifrado: false } },
        'seguridad',
      ],
      [
        'PDF con contraseña',
        { seguridad: { javascript: false, adjuntos: false, cifrado: true } },
        'seguridad',
      ],
    ])('%s', (_n, cambio, id) => {
      const r = evaluarPreflight({ ...bueno(), ...cambio }, TEXTIL);
      expect(r.bloquea).toBe(true);
      expect(r.estado).toBe(EstadoPreflight.BLOQUEADO);
      expect(r.reglas.find((x) => x.id === id)?.severidad).toBe('BLOQUEA');
    });

    it('dice la medida exacta para que el cliente sepa qué corregir', () => {
      expect(regla({ ...bueno(), anchoCm: 61 }, 'ancho')?.detalle).toContain('61 cm');
      expect(regla({ ...bueno(), altoCm: 260 }, 'alto')?.detalle).toContain('Divídelo');
    });

    it('±0.5 cm de ancho se tolera (los puntos del PDF no son milímetros exactos)', () => {
      expect(regla({ ...bueno(), anchoCm: 57.4 }, 'ancho')?.severidad).toBe('OK');
      expect(regla({ ...bueno(), anchoCm: 56.4 }, 'ancho')?.severidad).toBe('BLOQUEA');
    });
  });

  describe('lo que solo AVISA (depende de criterio: la última palabra es de Impresión)', () => {
    it.each([
      ['fondo blanco', { fondo: 'BLANCO' as const }, 'fondo'],
      ['fondo de color', { fondo: 'COLOR' as const }, 'fondo'],
      ['resolución de 210 ppi', { imagenes: 1, dpiEfectivoMin: 210 }, 'resolucion'],
      ['resolución de 90 ppi', { imagenes: 1, dpiEfectivoMin: 90 }, 'resolucion'],
      ['letra de 3 pt', { textoMinPt: 3 }, 'texto'],
      ['RGB', { modoColor: 'RGB' as const }, 'color'],
      ['sombras', { semitransparente: 0.3 }, 'transparencias'],
      ['más corto que el mínimo', { altoCm: 30 }, 'alto'],
    ])('%s', (_n, cambio, id) => {
      const r = evaluarPreflight({ ...bueno(), ...cambio }, TEXTIL);
      expect(r.bloquea).toBe(false);
      expect(r.estado).toBe(EstadoPreflight.CON_AVISOS);
      expect(r.reglas.find((x) => x.id === id)?.severidad).toBe('AVISO');
    });

    it('un PDF vectorial no tiene "resolución baja": no hay píxeles que se vean grandes', () => {
      expect(regla(bueno(), 'resolucion')?.detalle).toContain('Vectorial');
    });

    it('un PNG no se reprocha por estar en RGB', () => {
      const r = evaluarPreflight({ ...bueno(), formato: 'png', modoColor: 'RGB' }, TEXTIL);
      expect(r.reglas.find((x) => x.id === 'color')).toBeUndefined();
    });

    it('un PNG sin resolución cuyo ancho no cuadra AVISA en vez de bloquear', () => {
      const r = evaluarPreflight(
        { ...bueno(), formato: 'png', anchoCm: 30, dpiAsumido: true },
        TEXTIL,
      );
      expect(r.bloquea).toBe(false);
      expect(r.reglas.find((x) => x.id === 'ancho')?.severidad).toBe('AVISO');
    });
  });

  describe('ahorro sugerido', () => {
    it('avisa cuánto se ahorra si el diseño ocupa mucho menos que el lienzo', () => {
      // Lienzo de 250 cm con un diseño que ocupa ~20 % (50 cm): cobra 250, recortado a ~52 → 100.
      const m = { ...bueno(), altoCm: 250, contenido: { x0: 0, y0: 0, x1: 1, y1: 0.2 } };
      const a = evaluarPreflight(m, TEXTIL).reglas.find((x) => x.id === 'ahorro');
      expect(a?.severidad).toBe('INFO');
      expect(a?.detalle).toContain('$');
    });

    it('no molesta si el lienzo ya está ajustado al diseño', () => {
      expect(regla(bueno(), 'ahorro')).toBeUndefined();
    });

    it('es INFO: no ensucia el semáforo', () => {
      const m = { ...bueno(), altoCm: 250, contenido: { x0: 0, y0: 0, x1: 1, y1: 0.2 } };
      expect(evaluarPreflight(m, TEXTIL).estado).toBe(EstadoPreflight.OK);
    });
  });

  describe('si el análisis falla NO bloquea (D8)', () => {
    it('queda NO_CONCLUYENTE y pasa a revisión humana', () => {
      const r = preflightNoConcluyente('Se agotó el tiempo.');
      expect(r.estado).toBe(EstadoPreflight.NO_CONCLUYENTE);
      expect(r.bloquea).toBe(false);
      expect(r.reglas[0].detalle).toContain('Una persona de Impresión');
    });
  });
});
