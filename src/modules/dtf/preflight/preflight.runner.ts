import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { Mediciones } from '../core/dtf-reglas.util';
import { FormatoDtf } from '../core/dtf-formato.util';

export type Medicion = Mediciones & { previewAncho?: number; previewAlto?: number; ms?: number };
export type ResultadoMedicion = { ok: true; m: Medicion } | { ok: false; error: string };

/**
 * Lanza el proceso hijo que MIDE un archivo (`preflight-worker.js`). Aislamiento (PLAN-DTF.md §7.3): el
 * análisis de un PDF ajeno corre fuera del API, con tope de memoria y de tiempo. Si el hijo se cae o
 * se pasa de tiempo, devuelve `ok: false` y el trabajo queda "no concluyente": nunca bloquea ni tumba
 * al API.
 */
@Injectable()
export class PreflightRunner {
  private readonly logger = new Logger(PreflightRunner.name);

  constructor(private readonly config: ConfigService) {}

  /** En dev (watch) el .js puede no estar aún en dist/: se cae al de src/. */
  private rutaWorker(): string {
    const candidatos = [
      join(__dirname, 'preflight-worker.js'),
      join(process.cwd(), 'src', 'modules', 'dtf', 'preflight', 'preflight-worker.js'),
    ];
    const ruta = candidatos.find((c) => existsSync(c));
    if (!ruta) throw new Error('No se encontró preflight-worker.js');
    return ruta;
  }

  medir(archivo: string, formato: FormatoDtf, previewPath: string): Promise<ResultadoMedicion> {
    const cfg = this.config.get('app.dtf') || {};
    const timeout = cfg.preflightTimeoutMs ?? 90_000;
    const memoria = cfg.preflightMemoriaMb ?? 2048;
    let worker: string;
    try {
      worker = this.rutaWorker();
    } catch (e) {
      return Promise.resolve({ ok: false, error: (e as Error).message });
    }
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          `--max-old-space-size=${memoria}`,
          worker,
          archivo,
          formato,
          previewPath,
          JSON.stringify({ previewLado: 2400 }),
        ],
        { timeout, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH ?? '' } },
        (err, stdout) => {
          const linea = String(stdout ?? '')
            .trim()
            .split('\n')
            .filter(Boolean)
            .pop();
          if (linea) {
            try {
              const r = JSON.parse(linea);
              if (r.ok) return resolve({ ok: true, m: r.m });
              return resolve({ ok: false, error: r.error || 'No se pudo analizar el archivo.' });
            } catch {
              /* cae abajo */
            }
          }
          const motivo =
            err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed
              ? 'Se agotó el tiempo de análisis.'
              : 'El análisis automático falló.';
          this.logger.warn(`Preflight falló (${archivo}): ${err?.message ?? 'sin salida'}`);
          resolve({ ok: false, error: motivo });
        },
      );
    });
  }
}
