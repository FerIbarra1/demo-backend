import { estimarHoraEntrega, horaLocal, pasoLaHoraDeCorte } from './dtf-eta.util';

const AHORA = new Date('2026-10-17T18:00:00Z'); // 11:00 en Hermosillo (UTC-7, sin horario de verano)

describe('hora estimada de entrega', () => {
  it('metros por delante + los propios ÷ velocidad + holgura, redondeado a 5 min', () => {
    // 3 m por delante + 1 m = 4 m a 6 m/h = 40 min + 10 = 50 min
    const h = estimarHoraEntrega({
      ahora: AHORA,
      metrosPorDelante: 3,
      metros: 1,
      velocidadMetrosHora: 6,
    });
    expect(h?.toISOString()).toBe('2026-10-17T18:50:00.000Z');
  });

  it('sin velocidad configurada no inventa una hora', () => {
    expect(
      estimarHoraEntrega({
        ahora: AHORA,
        metrosPorDelante: 0,
        metros: 1,
        velocidadMetrosHora: null,
      }),
    ).toBeNull();
    expect(
      estimarHoraEntrega({ ahora: AHORA, metrosPorDelante: 0, metros: 1, velocidadMetrosHora: 0 }),
    ).toBeNull();
  });

  it('una cola vacía cuesta solo el trabajo y la holgura', () => {
    const h = estimarHoraEntrega({
      ahora: AHORA,
      metrosPorDelante: 0,
      metros: 0.5,
      velocidadMetrosHora: 6,
      holguraMin: 10,
    });
    // 0.5 m / 6 = 5 min + 10 = 15
    expect(h?.getTime()).toBe(AHORA.getTime() + 15 * 60_000);
  });
});

describe('hora de corte (zona de la tienda, no la del servidor)', () => {
  it('lee la hora local de la zona', () => {
    expect(horaLocal(AHORA, 'America/Hermosillo')).toEqual({ h: 11, m: 0 });
  });

  it('pasó / no pasó', () => {
    expect(pasoLaHoraDeCorte(AHORA, '15:00', 'America/Hermosillo')).toBe(false);
    expect(pasoLaHoraDeCorte(AHORA, '11:00', 'America/Hermosillo')).toBe(true);
    expect(pasoLaHoraDeCorte(AHORA, null, 'America/Hermosillo')).toBe(false);
    expect(pasoLaHoraDeCorte(AHORA, 'basura', 'America/Hermosillo')).toBe(false);
  });
});
