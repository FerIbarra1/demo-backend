import { redactarParaGerente } from './salud-gerente';
import type { SaludSistema } from './salud-sistema.service';

/**
 * La vista del GERENTE se arma por LISTA BLANCA: este spec fija las llaves EXACTAS, así que un campo técnico que
 * mañana se agregue a `SaludSistema` (texto de un error, ruta interna del ERP) no llega al gerente por accidente.
 */
const completa = (): SaludSistema => ({
  generadoAt: '2026-10-17T12:00:00.000Z',
  nivel: 'rojo',
  motivos: [
    { area: 'agente', nivel: 'rojo', texto: 'Mexicali: el agente no reporta hace 42 min' },
    { area: 'outbox', nivel: 'ambar', texto: '5 eventos de realtime sin emitir' },
    { area: 'workers', nivel: 'rojo', texto: 'El barrido «estaciones» no corre' },
  ],
  erp: [
    {
      tienda: { id: 1, nombre: 'Punto Textil Mexicali', ciudad: 'Mexicali' },
      nivel: 'rojo',
      motivos: ['no reporta hace 42 min'],
      agente: {
        estado: 'SIN_LATIDO',
        ultimoLatidoAt: '2026-10-17T11:18:00.000Z',
        minutosSinLatido: 42,
        version: '1.2.3',
        ultimoError: 'C:\\datos\\sistema.fdb: conexión rechazada',
        ultimoErrorAt: '2026-10-17T11:19:00.000Z',
      },
      bandeja: {
        pendientes: 8,
        procesando: 0,
        reintentos: 1,
        expirados: 0,
        conProblema: [
          {
            pedidoId: 10,
            numeroPedido: 'PD-2026-000010',
            estado: 'RETRY',
            intentos: 4,
            minutos: 45,
            ultimoError: 'GRABAR_PEDIDOS: violation of FOREIGN KEY constraint',
            ultimoErrorCode: 'FB_FK',
          },
        ],
      },
      folios: {
        sinAsignar: 2,
        masViejaMin: 12,
        conError: 1,
        conProblema: [
          {
            pedidoId: 11,
            numeroPedido: 'PD-2026-000011',
            intentos: 3,
            minutos: 12,
            // El texto del agente (puede traer rutas y nombres de tablas): es del ADMIN.
            ultimoError:
              'CONSECUTIVOS: la tienda 1 no tiene consecutivo de PEDIDOS (C:\\datos\\sistema.fdb)',
          },
        ],
      },
      conciliacion: {
        ultimaAt: '2026-10-17T11:50:00.000Z',
        minutosDesde: 10,
        revisados: 37,
        corregidas24h: 2,
        abiertas: [
          {
            id: 5,
            pedidoId: 10,
            numeroPedido: 'PD-2026-000010',
            folio: '0000012345',
            tipo: 'COBRADO_Y_CANCELADO',
            titulo: 'Cobrado y cancelado',
            que: 'El Sistema Comercial lo tiene cobrado y la web lo canceló.',
            desdeAt: '2026-10-17T10:00:00.000Z',
            minutos: 120,
            // Lo crudo de cada lado (estados, SWCANCEL, totales): es del ADMIN.
            detalle: { nube: 'CANCELADO', erp: { swcancel: false, finalizada: true, total: 999 } },
          },
        ],
      },
    },
  ],
  eventosSync: {
    error: 1,
    muertos: 2,
    recientes: [
      {
        eventId: 'evt-1',
        tiendaId: 1,
        entidad: 'PEDIDO',
        estado: 'DEAD_LETTER',
        intentos: 5,
        ultimoErrorCode: 'X',
        mensaje: 'tabla PEDIDOS bloqueada',
        createdAt: '2026-10-17T11:00:00.000Z',
      },
    ],
  },
  kioskos: { activos: 1, caidos: [], sinCredencial: 0 },
  pantallas: [],
  outbox: { sinEmitir: 5, masViejoMin: 3 },
  workers: [
    {
      nombre: 'estaciones',
      periodoSeg: 300,
      ultimaCorridaAt: null,
      minutosDesdeCorrida: 40,
      ultimoError: 'boom',
      nivel: 'rojo',
    },
  ],
});

describe('redactarParaGerente', () => {
  const g = redactarParaGerente(completa());

  it('trae exactamente estas llaves (lista blanca)', () => {
    expect(Object.keys(g).sort()).toEqual([
      'erp',
      'eventosSync',
      'generadoAt',
      'kioskos',
      'motivos',
      'nivel',
      'pantallas',
    ]);
    expect(Object.keys(g.erp[0].agente).sort()).toEqual([
      'estado',
      'minutosSinLatido',
      'ultimoLatidoAt',
      'version',
    ]);
    expect(Object.keys(g.erp[0].bandeja.conProblema[0]).sort()).toEqual([
      'estado',
      'intentos',
      'minutos',
      'numeroPedido',
      'pedidoId',
    ]);
    // Los folios que esperan al Sistema Comercial: cuántos, cuánto llevan y cuáles. Sin el texto del error del agente.
    expect(Object.keys(g.erp[0].folios).sort()).toEqual([
      'conError',
      'conProblema',
      'masViejaMin',
      'sinAsignar',
    ]);
    expect(Object.keys(g.erp[0].folios.conProblema[0]).sort()).toEqual([
      'intentos',
      'minutos',
      'numeroPedido',
      'pedidoId',
    ]);
    expect(g.eventosSync).toEqual({ error: 1, muertos: 2 });
    // La conciliación: qué pasa, con qué pedido y desde cuándo. Sin `detalle` ni cuántos se revisaron.
    expect(Object.keys(g.erp[0].conciliacion).sort()).toEqual([
      'abiertas',
      'corregidas24h',
      'minutosDesde',
      'ultimaAt',
    ]);
    expect(Object.keys(g.erp[0].conciliacion.abiertas[0]).sort()).toEqual([
      'folio',
      'minutos',
      'numeroPedido',
      'pedidoId',
      'que',
      'tipo',
      'titulo',
    ]);
  });

  it('ningún texto técnico del ERP sobrevive, en ninguna parte', () => {
    const crudo = JSON.stringify(g);
    for (const secreto of [
      'sistema.fdb',
      'FOREIGN KEY',
      'FB_FK',
      'bloqueada',
      'boom',
      'CONSECUTIVOS',
      'evt-1',
      // el `detalle` crudo de la conciliación
      'swcancel',
      '"total":999',
    ]) {
      expect(crudo).not.toContain(secreto);
    }
  });

  it('quita los motivos del SISTEMA (outbox y barridos) y deja los de su tienda', () => {
    expect(g.motivos.map((m) => m.area)).toEqual(['agente']);
  });

  it('lo que el gerente SÍ necesita se conserva: agente, conteos y qué pedidos esperan', () => {
    expect(g.erp[0].agente.minutosSinLatido).toBe(42);
    expect(g.erp[0].bandeja.pendientes).toBe(8);
    expect(g.erp[0].bandeja.conProblema[0].numeroPedido).toBe('PD-2026-000010');
    expect(g.erp[0].folios.sinAsignar).toBe(2);
    expect(g.erp[0].folios.conProblema[0].numeroPedido).toBe('PD-2026-000011');
  });
});
