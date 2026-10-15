import { estadoDeEspera, umbralesSinRecoger } from './sin-recoger.util';

/**
 * F22: los plazos de los pedidos apartados que nadie recoge. Se leen en TRES
 * sitios (el barrido, la consola del mostrador y el cliente) y tienen que ser los
 * mismos números: si cada uno calculara su propio "vencido", el operador vería un
 * pedido vencido que el correo del cliente todavía no dio por perdido.
 */
const config = (c: Record<string, unknown> | undefined) => ({ get: () => c }) as never;

describe('umbralesSinRecoger', () => {
  it('toma los valores de la configuración', () => {
    expect(
      umbralesSinRecoger(
        config({ recordatorioHoras: 12, vencidoHoras: 48, presenciaCaducaHoras: 6 }),
      ),
    ).toEqual({ recordatorioHoras: 12, vencidoHoras: 48, presenciaCaducaHoras: 6 });
  });

  it('sin configuración usa 24 h / 72 h / 8 h', () => {
    expect(umbralesSinRecoger(config(undefined))).toEqual({
      recordatorioHoras: 24,
      vencidoHoras: 72,
      presenciaCaducaHoras: 8,
    });
    expect(umbralesSinRecoger(undefined)).toEqual({
      recordatorioHoras: 24,
      vencidoHoras: 72,
      presenciaCaducaHoras: 8,
    });
  });

  it('un valor inválido (NaN, 0, negativo) cae al default, no a cancelar pedidos', () => {
    // `parseInt('abc')` es NaN; con NaN, `horas >= NaN` es siempre falso y el
    // recordatorio nunca saldría — o con 0, saldría para TODOS al instante.
    const u = umbralesSinRecoger(
      config({ recordatorioHoras: NaN, vencidoHoras: -5, presenciaCaducaHoras: 0 }),
    );
    expect(u).toEqual({ recordatorioHoras: 24, vencidoHoras: 72, presenciaCaducaHoras: 8 });
  });

  it('el vencimiento SIEMPRE va después del recordatorio', () => {
    // Configurado al revés (vence antes de avisar), el cliente podría ser dado por
    // perdido sin haber recibido nunca el "¿aún lo quieres?".
    const u = umbralesSinRecoger(config({ recordatorioHoras: 48, vencidoHoras: 24 }));
    expect(u.vencidoHoras).toBeGreaterThan(u.recordatorioHoras);
  });
});

describe('estadoDeEspera', () => {
  const u = { recordatorioHoras: 24, vencidoHoras: 72, presenciaCaducaHoras: 8 };
  const horas = (h: number) => new Date(Date.now() - h * 3_600_000);

  it('sin marca de espera no hay estado (el pedido no está apartado)', () => {
    expect(estadoDeEspera(null, u)).toBeNull();
  });

  it('antes del recordatorio: ni recordable ni vencido', () => {
    expect(estadoDeEspera(horas(5), u)).toMatchObject({ recordable: false, vencido: false });
  });

  it('pasado el recordatorio: recordable pero NO vencido (el cliente aún puede contestar)', () => {
    expect(estadoDeEspera(horas(30), u)).toMatchObject({ recordable: true, vencido: false });
  });

  it('pasado el plazo: vencido', () => {
    expect(estadoDeEspera(horas(80), u)).toMatchObject({ recordable: true, vencido: true });
  });

  it('el borde es inclusivo: justo a las 72 h ya está vencido', () => {
    const ahora = Date.now();
    expect(estadoDeEspera(new Date(ahora - 72 * 3_600_000), u, ahora)?.vencido).toBe(true);
    expect(estadoDeEspera(new Date(ahora - 72 * 3_600_000 + 1), u, ahora)?.vencido).toBe(false);
  });

  it('reporta las horas esperando', () => {
    expect(estadoDeEspera(horas(30), u)?.horasEsperando).toBeCloseTo(30, 1);
  });
});
