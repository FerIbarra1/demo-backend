import { Global, Injectable, Module } from '@nestjs/common';

/**
 * N3 (oct 2026, "salud del sistema"): la última vez que corrió cada worker.
 *
 * Los barridos (estaciones, kioskos, DTF, el outbox de realtime) son `setInterval` que fallan EN SILENCIO: si uno se
 * cae o se atora, nadie lo ve hasta que se nota lo que dejó de hacer (puestos que no se sueltan, avisos que no llegan).
 * Cada uno declara su periodo al arrancar y avisa al terminar cada pasada; la pantalla de salud compara la última
 * corrida con el periodo esperado.
 *
 * EN MEMORIA, a propósito: guardarlo en la BD sería una escritura por pasada (el outbox corre cada segundo) para un dato
 * que solo importa mientras el proceso vive. Al reiniciar el servidor todos empiezan en "aún no corre" y se ponen al día
 * en su primer periodo; la pantalla lo cuenta desde que el worker se DECLARÓ, no desde el epoch, así que un reinicio
 * reciente no los pinta de rojo. Se inyecta como `@Optional()`: los workers (y sus specs) funcionan igual sin él.
 */
export interface EntradaWorker {
  nombre: string;
  periodoMs: number;
  declaradoAt: Date;
  ultimaCorridaAt: Date | null;
  ultimoError: string | null;
  ultimoErrorAt: Date | null;
  corridas: number;
}

@Injectable()
export class ActividadWorkers {
  private readonly registro = new Map<string, EntradaWorker>();

  declarar(nombre: string, periodoMs: number, ahora: Date = new Date()): void {
    if (this.registro.has(nombre)) return;
    this.registro.set(nombre, {
      nombre,
      periodoMs,
      declaradoAt: ahora,
      ultimaCorridaAt: null,
      ultimoError: null,
      ultimoErrorAt: null,
      corridas: 0,
    });
  }

  corrio(nombre: string, ahora: Date = new Date()): void {
    const e = this.registro.get(nombre);
    if (!e) return;
    e.ultimaCorridaAt = ahora;
    e.corridas += 1;
  }

  fallo(nombre: string, mensaje: string, ahora: Date = new Date()): void {
    const e = this.registro.get(nombre);
    if (!e) return;
    e.ultimoError = mensaje.slice(0, 300);
    e.ultimoErrorAt = ahora;
  }

  /** Copia (la pantalla no debe poder mutar el registro). */
  instantanea(): EntradaWorker[] {
    return [...this.registro.values()].map((e) => ({ ...e }));
  }
}

/** Global: los workers viven en módulos distintos y ninguno debería importar a otro solo para esto. */
@Global()
@Module({ providers: [ActividadWorkers], exports: [ActividadWorkers] })
export class ActividadWorkersModule {}
