import {
  armarSemaforo,
  duracionLegible,
  esperaDeLaMasVieja,
  esperaMasLarga,
  minutosDesde,
  nivelDeEspera,
  peorNivel,
  umbralSinRegistrar,
  UMBRALES_MIN,
} from './torre-control.util';

describe('nivelDeEspera: la frontera es inclusiva (llegar al umbral YA es el nivel)', () => {
  const u = { ambar: 10, rojo: 20 };
  it.each([
    [0, 'verde'],
    [9, 'verde'],
    [10, 'ambar'],
    [19, 'ambar'],
    [20, 'rojo'],
    [500, 'rojo'],
  ])('%i min → %s', (min, esperado) => {
    expect(nivelDeEspera(min, u)).toBe(esperado);
  });
});

describe('peorNivel', () => {
  it('sin niveles es verde; gana el peor', () => {
    expect(peorNivel([])).toBe('verde');
    expect(peorNivel(['verde', 'ambar', 'verde'])).toBe('ambar');
    expect(peorNivel(['ambar', 'rojo', 'verde'])).toBe('rojo');
  });
});

describe('armarSemaforo', () => {
  it('nadie espera → verde y sin motivos', () => {
    expect(armarSemaforo({}, 4)).toEqual({ nivel: 'verde', motivos: [] });
    expect(armarSemaforo({ caja: null, bodega: null }, 4)).toEqual({ nivel: 'verde', motivos: [] });
  });

  it('esperas bajo el umbral siguen verdes', () => {
    const r = armarSemaforo(
      { caja: { minutos: UMBRALES_MIN.caja.ambar - 1, referencia: 'PD-1' } },
      4,
    );
    expect(r.nivel).toBe('verde');
    expect(r.motivos).toEqual([]);
  });

  it('UNA etapa roja pone la tienda roja aunque todo lo demás vaya bien', () => {
    const r = armarSemaforo(
      {
        bodega: { minutos: 2, referencia: 'PD-1' },
        caja: { minutos: 25, referencia: 'PD-2026-000016' },
      },
      4,
    );
    expect(r.nivel).toBe('rojo');
    expect(r.motivos).toHaveLength(1);
    expect(r.motivos[0]).toEqual({
      etapa: 'caja',
      nivel: 'rojo',
      minutos: 25,
      referencia: 'PD-2026-000016',
      texto: 'Caja: 25 min esperando (PD-2026-000016)',
    });
  });

  it('cada etapa usa SU umbral: 40 min es rojo en bodega sin tomar, ámbar surtiendo y verde en transferencias', () => {
    expect(armarSemaforo({ bodega: { minutos: 40, referencia: null } }, 4).nivel).toBe('rojo');
    expect(armarSemaforo({ surtido: { minutos: 40, referencia: null } }, 4).nivel).toBe('ambar');
    expect(armarSemaforo({ transferencias: { minutos: 40, referencia: null } }, 4).nivel).toBe(
      'verde',
    );
  });

  it('los motivos van del peor al menos malo, y a igual nivel el que más espera primero', () => {
    const r = armarSemaforo(
      {
        bodega: { minutos: 16, referencia: 'A' }, // ámbar
        caja: { minutos: 12, referencia: 'B' }, // ámbar
        mostrador: { minutos: 30, referencia: 'C' }, // rojo
      },
      4,
    );
    expect(r.motivos.map((m) => m.etapa)).toEqual(['mostrador', 'bodega', 'caja']);
  });

  it('"sin registrar" usa las horas de alerta de Tesorería (4 h → ámbar a 240 min, rojo a 720)', () => {
    expect(umbralSinRegistrar(4)).toEqual({ ambar: 240, rojo: 720 });
    expect(armarSemaforo({ sinRegistrar: { minutos: 239, referencia: null } }, 4).nivel).toBe(
      'verde',
    );
    expect(armarSemaforo({ sinRegistrar: { minutos: 240, referencia: null } }, 4).nivel).toBe(
      'ambar',
    );
    expect(armarSemaforo({ sinRegistrar: { minutos: 720, referencia: null } }, 4).nivel).toBe(
      'rojo',
    );
    // Si Tesorería lo configura en 1 h, la torre lo sigue.
    expect(armarSemaforo({ sinRegistrar: { minutos: 61, referencia: null } }, 1).nivel).toBe(
      'ambar',
    );
  });

  it('una configuración inválida (0 o negativa) cae en 4 h en vez de poner todo en rojo', () => {
    expect(umbralSinRegistrar(0)).toEqual({ ambar: 240, rojo: 720 });
    expect(umbralSinRegistrar(-3)).toEqual({ ambar: 240, rojo: 720 });
  });
});

describe('esperaMasLarga', () => {
  it('es la mayor de todas las etapas, aunque sea verde', () => {
    expect(
      esperaMasLarga({
        bodega: { minutos: 3, referencia: 'A' },
        caja: { minutos: 8, referencia: 'B' },
        dtf: null,
      }),
    ).toEqual({ etapa: 'caja', minutos: 8, referencia: 'B' });
  });
  it('nadie espera → null', () => {
    expect(esperaMasLarga({})).toBeNull();
    expect(esperaMasLarga({ caja: null })).toBeNull();
  });
});

describe('minutosDesde / esperaDeLaMasVieja', () => {
  const ahora = new Date('2026-10-17T12:00:00Z');
  it('minutos enteros, nunca negativos, null sin fecha', () => {
    expect(minutosDesde(new Date('2026-10-17T11:30:30Z'), ahora)).toBe(29);
    expect(minutosDesde(new Date('2026-10-17T12:05:00Z'), ahora)).toBe(0); // reloj adelantado
    expect(minutosDesde(null, ahora)).toBeNull();
  });
  it('de varias filas elige la más antigua con su referencia; ignora las sin fecha', () => {
    const r = esperaDeLaMasVieja(
      [
        { desde: new Date('2026-10-17T11:50:00Z'), referencia: 'nuevo' },
        { desde: null, referencia: 'sin fecha' },
        { desde: new Date('2026-10-17T11:00:00Z'), referencia: 'viejo' },
      ],
      ahora,
    );
    expect(r).toEqual({ minutos: 60, referencia: 'viejo' });
    expect(esperaDeLaMasVieja([], ahora)).toBeNull();
  });
});

describe('duracionLegible', () => {
  it.each([
    [0, '0 min'],
    [24, '24 min'],
    [60, '1 h'],
    [125, '2 h 5 min'],
    [180, '3 h'],
  ])('%i → %s', (m, t) => expect(duracionLegible(m)).toBe(t));
});
