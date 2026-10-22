import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PreflightRunner } from './preflight.runner';
import { evaluarPreflight, ParametrosTipo } from '../core/dtf-reglas.util';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generarEjemplos } = require('../../../../scripts/dtf-ejemplos.js');

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

/**
 * Corre el motor REAL (proceso hijo, pdfjs, canvas, sharp) contra los archivos de ejemplo: cada uno
 * cuenta una historia distinta en el semáforo. Es lo que la demo enseña.
 */
describe('motor de revisión automática (archivos reales)', () => {
  jest.setTimeout(120_000);
  let dir: string;
  let ej: Record<string, string>;
  const runner = new PreflightRunner({
    get: () => ({ preflightTimeoutMs: 90_000, preflightMemoriaMb: 2048 }),
  } as unknown as ConfigService);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dtf-ej-'));
    ej = await generarEjemplos(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const revisar = async (ruta: string, formato: 'pdf' | 'png') => {
    const r = await runner.medir(ruta, formato, join(dir, `prev-${Math.random()}.png`));
    if (!r.ok) throw new Error(r.error);
    return { m: r.m, sem: evaluarPreflight(r.m, TEXTIL) };
  };
  const sev = (sem: ReturnType<typeof evaluarPreflight>, id: string) =>
    sem.reglas.find((x) => x.id === id)?.severidad;

  it('un diseño vectorial bien hecho sale OK y genera su vista previa con transparencia', async () => {
    const { m, sem } = await revisar(ej.cancerOk, 'pdf');
    expect(m.anchoCm).toBeCloseTo(57, 1);
    expect(m.altoCm).toBeCloseTo(62, 1);
    expect(m.modoColor).toBe('CMYK');
    expect(sem.estado).toBe('OK');
    expect(existsSync(join(dir))).toBe(true);
  });

  it('fondo blanco → AVISA', async () => {
    const { m, sem } = await revisar(ej.fondoBlanco, 'pdf');
    expect(m.fondo).toBe('BLANCO');
    expect(sev(sem, 'fondo')).toBe('AVISO');
  });

  it('ancho de 61 cm → BLOQUEA con la medida exacta', async () => {
    const { sem } = await revisar(ej.anchoMal, 'pdf');
    expect(sem.bloquea).toBe(true);
    expect(sem.reglas.find((x) => x.id === 'ancho')?.detalle).toContain('61 cm');
  });

  it('foto de baja resolución → AVISA con su ppi efectivo', async () => {
    const { m, sem } = await revisar(ej.bajaRes, 'pdf');
    expect(Math.round(m.dpiEfectivoMin ?? 0)).toBeLessThan(60);
    expect(sev(sem, 'resolucion')).toBe('AVISO');
  });

  it('letra de 4 pt → AVISA', async () => {
    const { m, sem } = await revisar(ej.letraChica, 'pdf');
    expect(m.textoMinPt).toBeLessThan(6);
    expect(sev(sem, 'texto')).toBe('AVISO');
  });

  it('RGB con sombras → AVISA color y transparencias', async () => {
    const { sem } = await revisar(ej.rgbSombras, 'pdf');
    expect(sev(sem, 'color')).toBe('AVISO');
    expect(sev(sem, 'transparencias')).toBe('AVISO');
  });

  it('270 cm de largo → BLOQUEA; dos páginas → BLOQUEA', async () => {
    expect(
      (await revisar(ej.muyLargo, 'pdf')).sem.reglas.find((x) => x.id === 'alto')?.severidad,
    ).toBe('BLOQUEA');
    expect(
      (await revisar(ej.dosPaginas, 'pdf')).sem.reglas.find((x) => x.id === 'paginas')?.severidad,
    ).toBe('BLOQUEA');
  });

  it('lienzo de 250 cm con un diseño chico → sugiere el ahorro', async () => {
    const { sem } = await revisar(ej.ocupaPoco, 'pdf');
    expect(sem.reglas.find((x) => x.id === 'ahorro')?.detalle).toContain('ahorras $');
  });

  it('UV de 20 cm de alto: bien con su mínimo', async () => {
    const r = await runner.medir(ej.nombresUv, 'pdf', join(dir, 'uv.png'));
    if (!r.ok) throw new Error(r.error);
    const sem = evaluarPreflight(r.m, {
      ...TEXTIL,
      minimoCm: 20,
      pasoCobroCm: 20,
      precioMetro: 600,
    });
    expect(sem.bloquea).toBe(false);
    expect(sev(sem, 'alto')).toBe('OK');
  });

  it('PNG con fondo blanco → AVISA; PNG transparente a 300 ppi → OK', async () => {
    expect(sev((await revisar(ej.pngFondo, 'png')).sem, 'fondo')).toBe('AVISO');
    const ok = await revisar(ej.pngOk, 'png');
    expect(ok.m.fondo).toBeNull();
    expect(ok.sem.estado).toBe('OK');
  });

  it('un archivo que no es PDF no revienta: devuelve error controlado', async () => {
    const r = await runner.medir(ej.noEsPdf, 'pdf', join(dir, 'x.png'));
    expect(r.ok).toBe(false);
  });
});
