import {
  evaluarAgente,
  evaluarBandeja,
  evaluarConciliacion,
  evaluarEventos,
  evaluarFolios,
  evaluarKioskos,
  evaluarOutbox,
  evaluarPantalla,
  evaluarWorker,
  UMBRALES_SALUD,
} from './salud-sistema.util';

const base = {
  pendienteMasViejoMin: null,
  pendienteReferencia: null,
  reintentos: 0,
  reintentoMasViejoMin: null,
  leaseVencidos: 0,
};

describe('evaluarAgente', () => {
  it('latido reciente → en línea y verde', () => {
    expect(evaluarAgente(1, false)).toEqual({ estado: 'EN_LINEA', nivel: 'verde', motivos: [] });
  });
  it.each([
    [UMBRALES_SALUD.agente.ambar, 'ambar'],
    [UMBRALES_SALUD.agente.rojo - 1, 'ambar'],
    [UMBRALES_SALUD.agente.rojo, 'rojo'],
  ])('%i min sin latido → %s (la frontera es inclusiva)', (min, nivel) => {
    const r = evaluarAgente(min, false);
    expect(r.nivel).toBe(nivel);
    expect(r.estado).toBe('SIN_LATIDO');
    expect(r.motivos[0].texto).toMatch(/no reporta hace/);
  });
  it('NUNCA conectado: verde si no hay nada que enviarle (aún no se instala), rojo si hay pedidos esperándolo', () => {
    expect(evaluarAgente(null, false)).toEqual({ estado: 'NUNCA', nivel: 'verde', motivos: [] });
    const r = evaluarAgente(null, true);
    expect(r.estado).toBe('NUNCA');
    expect(r.nivel).toBe('rojo');
  });
});

describe('evaluarBandeja', () => {
  it('vacía → verde', () => expect(evaluarBandeja(base)).toEqual({ nivel: 'verde', motivos: [] }));
  it('un PENDIENTE reciente es normal (el agente sondea cada tanto); uno viejo es ámbar y luego rojo', () => {
    expect(evaluarBandeja({ ...base, pendienteMasViejoMin: 2 }).nivel).toBe('verde');
    expect(
      evaluarBandeja({ ...base, pendienteMasViejoMin: 6, pendienteReferencia: 'PD-1' }).nivel,
    ).toBe('ambar');
    const r = evaluarBandeja({ ...base, pendienteMasViejoMin: 20, pendienteReferencia: 'PD-1' });
    expect(r.nivel).toBe('rojo');
    expect(r.motivos[0].texto).toBe(
      'Un pedido lleva 20 min en la bandeja sin que el agente lo tome (PD-1)',
    );
  });
  it('reintentos: ámbar desde que hay uno, rojo si el más viejo lleva 30 min', () => {
    expect(evaluarBandeja({ ...base, reintentos: 2, reintentoMasViejoMin: 3 }).nivel).toBe('ambar');
    expect(evaluarBandeja({ ...base, reintentos: 1, reintentoMasViejoMin: 30 }).nivel).toBe('rojo');
    expect(
      evaluarBandeja({ ...base, reintentos: 2, reintentoMasViejoMin: 3 }).motivos[0].texto,
    ).toMatch(/^2 pedidos en reintento/);
  });
  it('un lease vencido (el agente se cayó a medio proceso) es ámbar', () => {
    expect(evaluarBandeja({ ...base, leaseVencidos: 1 }).nivel).toBe('ambar');
  });
  it('los motivos van del rojo al ámbar', () => {
    const r = evaluarBandeja({
      ...base,
      leaseVencidos: 1,
      pendienteMasViejoMin: 40,
      pendienteReferencia: 'X',
    });
    expect(r.motivos.map((m) => m.nivel)).toEqual(['rojo', 'ambar']);
  });
});

describe('evaluarEventos', () => {
  it('sin fallas → verde; en ERROR (aún se reintenta) → ámbar; muerto → rojo', () => {
    expect(evaluarEventos({ error: 0, muertos: 0 }).nivel).toBe('verde');
    expect(evaluarEventos({ error: 3, muertos: 0 }).nivel).toBe('ambar');
    expect(evaluarEventos({ error: 3, muertos: 1 }).nivel).toBe('rojo');
    expect(evaluarEventos({ error: 3, muertos: 1 }).motivos).toHaveLength(2);
  });
});

describe('evaluarKioskos', () => {
  it('ninguno caído → verde', () =>
    expect(evaluarKioskos({ activos: 3, caidos: 0, sinCredencial: 0 }).nivel).toBe('verde'));
  it('algunos caídos → ámbar; TODOS los que deberían latir → rojo', () => {
    expect(evaluarKioskos({ activos: 3, caidos: 1, sinCredencial: 0 }).nivel).toBe('ambar');
    const r = evaluarKioskos({ activos: 2, caidos: 2, sinCredencial: 0 });
    expect(r.nivel).toBe('rojo');
    expect(r.motivos[0].texto).toMatch(/ninguno responde/);
  });
  it('sin kioskos activos no hay nada caído (0 de 0 no es "todos")', () => {
    expect(evaluarKioskos({ activos: 0, caidos: 0, sinCredencial: 0 }).nivel).toBe('verde');
  });
  it('sin credencial es ámbar aunque no estén caídos', () => {
    expect(evaluarKioskos({ activos: 1, caidos: 0, sinCredencial: 1 }).nivel).toBe('ambar');
  });
});

describe('evaluarPantalla', () => {
  it('nunca ha latido → no es alarma; reciente → en línea; vieja → ámbar y luego rojo', () => {
    expect(evaluarPantalla(null)).toEqual({ nivel: 'verde', enLinea: false });
    expect(evaluarPantalla(2)).toEqual({ nivel: 'verde', enLinea: true });
    expect(evaluarPantalla(10)).toEqual({ nivel: 'ambar', enLinea: false });
    expect(evaluarPantalla(30).nivel).toBe('rojo');
  });
});

describe('evaluarOutbox', () => {
  it('vacío → verde; con eventos viejos sin emitir → ámbar y luego rojo', () => {
    expect(evaluarOutbox({ sinEmitir: 0, masViejoMin: null }).nivel).toBe('verde');
    expect(evaluarOutbox({ sinEmitir: 3, masViejoMin: 1 }).nivel).toBe('verde');
    expect(evaluarOutbox({ sinEmitir: 3, masViejoMin: 2 }).nivel).toBe('ambar');
    expect(evaluarOutbox({ sinEmitir: 1, masViejoMin: 11 }).nivel).toBe('rojo');
  });
});

describe('evaluarWorker', () => {
  const declaradoAt = new Date('2026-10-17T12:00:00Z');
  const w = (o: Partial<Parameters<typeof evaluarWorker>[0]> = {}) => ({
    nombre: 'estaciones',
    periodoMs: 5 * 60_000,
    declaradoAt,
    ultimaCorridaAt: null,
    ultimoError: null,
    ultimoErrorAt: null,
    ...o,
  });
  const en = (min: number) => new Date(declaradoAt.getTime() + min * 60_000);

  it('recién arrancado y aún sin correr NO es rojo: se cuenta desde que se declaró', () => {
    expect(evaluarWorker(w(), en(4)).nivel).toBe('verde');
  });
  it('periodo de 5 min: ámbar a los 15 min sin correr, rojo a los 30', () => {
    expect(evaluarWorker(w({ ultimaCorridaAt: declaradoAt }), en(14)).nivel).toBe('verde');
    expect(evaluarWorker(w({ ultimaCorridaAt: declaradoAt }), en(15)).nivel).toBe('ambar');
    expect(evaluarWorker(w({ ultimaCorridaAt: declaradoAt }), en(30)).nivel).toBe('rojo');
  });
  it('el de 1 segundo tiene piso: un tropiezo de 5 s no es alarma; 1 min sí es ámbar; 5 min rojo', () => {
    const o = w({ nombre: 'realtime-outbox', periodoMs: 1000, ultimaCorridaAt: declaradoAt });
    expect(evaluarWorker(o, new Date(declaradoAt.getTime() + 5_000)).nivel).toBe('verde');
    expect(evaluarWorker(o, en(1)).nivel).toBe('ambar');
    expect(evaluarWorker(o, en(5)).nivel).toBe('rojo');
  });
  it('fallando en su último intento es ámbar aunque aún esté a tiempo, y lo dice', () => {
    const r = evaluarWorker(
      w({ ultimaCorridaAt: declaradoAt, ultimoError: 'boom', ultimoErrorAt: en(2) }),
      en(3),
    );
    expect(r.nivel).toBe('ambar');
    expect(r.motivos[0].texto).toBe('El barrido «estaciones» está fallando: boom');
  });
  it('un error VIEJO (ya corrió bien después) no cuenta', () => {
    const r = evaluarWorker(
      w({ ultimaCorridaAt: en(5), ultimoError: 'boom', ultimoErrorAt: en(2) }),
      en(6),
    );
    expect(r.nivel).toBe('verde');
  });
});

describe('evaluarConciliacion', () => {
  const hallazgo = (tipo: string, n = 1) => ({
    tipo,
    titulo: tipo,
    numeroPedido: `PD-${n}`,
  });
  const sana = { minutosDesdeUltima: 5, agenteEnLinea: true, abiertos: [] };

  it('al día y sin diferencias → verde', () => {
    expect(evaluarConciliacion(sana)).toEqual({ nivel: 'verde', motivos: [] });
  });

  it('dinero que no coincide → ROJO y nombra los pedidos (máx. 3 y "…")', () => {
    for (const tipo of ['COBRADO_Y_CANCELADO', 'REVERSA_DE_COBRO', 'TOTAL_DISTINTO']) {
      expect(evaluarConciliacion({ ...sana, abiertos: [hallazgo(tipo)] }).nivel).toBe('rojo');
    }
    const r = evaluarConciliacion({
      ...sana,
      abiertos: [1, 2, 3, 4].map((n) => hallazgo('TOTAL_DISTINTO', n)),
    });
    expect(r.motivos[0].texto).toContain('4 pedidos con dinero');
    expect(r.motivos[0].texto).toContain('PD-1, PD-2, PD-3…');
  });

  it('un pedido que no existe allá o estados raros → ámbar (no es dinero en juego)', () => {
    for (const tipo of ['NO_EXISTE_EN_ERP', 'CANCELADO_VIVO_EN_ERP', 'ESTADO_DISTINTO']) {
      expect(evaluarConciliacion({ ...sana, abiertos: [hallazgo(tipo)] }).nivel).toBe('ambar');
    }
  });

  it('el peor nivel manda y el rojo va primero', () => {
    const r = evaluarConciliacion({
      ...sana,
      abiertos: [hallazgo('NO_EXISTE_EN_ERP', 1), hallazgo('TOTAL_DISTINTO', 2)],
    });
    expect(r.nivel).toBe('rojo');
    expect(r.motivos.map((m) => m.nivel)).toEqual(['rojo', 'ambar']);
  });

  it.each([
    [UMBRALES_SALUD.conciliacion.ambar - 1, 'verde'],
    [UMBRALES_SALUD.conciliacion.ambar, 'ambar'],
    [UMBRALES_SALUD.conciliacion.rojo, 'rojo'],
  ])('con el agente en línea, %s min sin comparar → %s', (min, nivel) => {
    expect(evaluarConciliacion({ ...sana, minutosDesdeUltima: min }).nivel).toBe(nivel);
  });

  it('el agente en línea que NUNCA ha comparado → ámbar (¿versión anterior?)', () => {
    const r = evaluarConciliacion({ ...sana, minutosDesdeUltima: null });
    expect(r.nivel).toBe('ambar');
    expect(r.motivos[0].texto).toContain('aún no compara');
  });

  it('con el agente caído NO se duplica el aviso (ya lo da el agente), pero las diferencias abiertas siguen viéndose', () => {
    expect(
      evaluarConciliacion({ minutosDesdeUltima: null, agenteEnLinea: false, abiertos: [] }),
    ).toEqual({ nivel: 'verde', motivos: [] });
    expect(
      evaluarConciliacion({
        minutosDesdeUltima: 500,
        agenteEnLinea: false,
        abiertos: [hallazgo('TOTAL_DISTINTO')],
      }).nivel,
    ).toBe('rojo');
  });
});

describe('evaluarFolios (parte B: pedidos que esperan su folio del Sistema Comercial)', () => {
  const sano = { sinAsignar: 0, masViejaMin: null, referencia: null, conError: 0 };

  it('nadie esperando → verde', () => {
    expect(evaluarFolios(sano)).toEqual({ nivel: 'verde', motivos: [] });
  });

  it('esperando unos segundos es lo normal: el agente contesta en su siguiente ciclo', () => {
    expect(
      evaluarFolios({ ...sano, sinAsignar: 1, masViejaMin: 1, referencia: 'PD-1' }).nivel,
    ).toBe('verde');
  });

  it.each([
    [UMBRALES_SALUD.folios.ambar, 'ambar'],
    [UMBRALES_SALUD.folios.rojo - 1, 'ambar'],
    [UMBRALES_SALUD.folios.rojo, 'rojo'],
  ])('%i min sin folio → %s (la frontera es inclusiva)', (min, nivel) => {
    const r = evaluarFolios({
      ...sano,
      sinAsignar: 3,
      masViejaMin: min,
      referencia: 'PD-2026-000123',
    });
    expect(r.nivel).toBe(nivel);
    expect(r.motivos[0].texto).toMatch(/3 pedidos sin folio del Sistema Comercial/);
    expect(r.motivos[0].texto).toMatch(/PD-2026-000123/);
    expect(r.motivos[0].texto).toMatch(/bodega no puede imprimir su ticket/);
  });

  it('singular y plural', () => {
    expect(
      evaluarFolios({ ...sano, sinAsignar: 1, masViejaMin: 5, referencia: null }).motivos[0].texto,
    ).toMatch(/^1 pedido sin folio/);
  });

  it('el agente que intentó y falló es ámbar aunque la espera sea corta (con el motivo de por qué)', () => {
    const r = evaluarFolios({
      ...sano,
      sinAsignar: 1,
      masViejaMin: 1,
      referencia: 'PD-1',
      conError: 1,
    });
    expect(r.nivel).toBe('ambar');
    expect(r.motivos.map((m) => m.texto).join(' ')).toMatch(
      /no pudo reservar el folio de 1 pedido /,
    );
  });

  it('lo rojo va antes que lo ámbar', () => {
    const r = evaluarFolios({
      ...sano,
      sinAsignar: 2,
      masViejaMin: 30,
      referencia: 'PD-1',
      conError: 1,
    });
    expect(r.motivos.map((m) => m.nivel)).toEqual(['rojo', 'ambar']);
  });
});
