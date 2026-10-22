import { ActividadWorkers } from './actividad-workers';

describe('ActividadWorkers (N3: la última corrida de cada barrido)', () => {
  const t0 = new Date('2026-10-17T12:00:00Z');
  const t1 = new Date('2026-10-17T12:05:00Z');

  it('declarar registra el worker "aún sin correr", contado desde que se declaró', () => {
    const a = new ActividadWorkers();
    a.declarar('estaciones', 300_000, t0);
    expect(a.instantanea()).toEqual([
      {
        nombre: 'estaciones',
        periodoMs: 300_000,
        declaradoAt: t0,
        ultimaCorridaAt: null,
        ultimoError: null,
        ultimoErrorAt: null,
        corridas: 0,
      },
    ]);
  });

  it('declarar dos veces no reinicia nada (un módulo que arranca otra vez no borra la historia)', () => {
    const a = new ActividadWorkers();
    a.declarar('x', 1000, t0);
    a.corrio('x', t1);
    a.declarar('x', 9999, new Date());
    const [e] = a.instantanea();
    expect(e.periodoMs).toBe(1000);
    expect(e.ultimaCorridaAt).toEqual(t1);
    expect(e.corridas).toBe(1);
  });

  it('corrio y fallo actualizan lo suyo; un nombre que no se declaró se ignora sin lanzar', () => {
    const a = new ActividadWorkers();
    a.declarar('x', 1000, t0);
    a.fallo('x', 'boom', t1);
    a.corrio('fantasma');
    a.fallo('fantasma', 'nada');
    const [e] = a.instantanea();
    expect(e.ultimoError).toBe('boom');
    expect(e.ultimoErrorAt).toEqual(t1);
    expect(e.ultimaCorridaAt).toBeNull();
    expect(a.instantanea()).toHaveLength(1);
  });

  it('el mensaje de error se recorta (no guarda un stack entero en memoria)', () => {
    const a = new ActividadWorkers();
    a.declarar('x', 1000, t0);
    a.fallo('x', 'e'.repeat(5000));
    expect(a.instantanea()[0].ultimoError).toHaveLength(300);
  });

  it('la instantánea es una COPIA: mutarla no toca el registro', () => {
    const a = new ActividadWorkers();
    a.declarar('x', 1000, t0);
    a.instantanea()[0].corridas = 99;
    expect(a.instantanea()[0].corridas).toBe(0);
  });
});
