import 'dotenv/config';
import { EstadoPedido, ModoEntrega, PrismaClient, RolUsuario } from '@prisma/client';
import { ActividadWorkers } from '../../common/actividad-workers';
import { SaludSistemaService } from './salud-sistema.service';

/**
 * N3 (oct 2026) contra PostgreSQL REAL: la salud del Sistema Comercial por tienda (agente, bandeja) y los eventos de
 * sync fallidos. Se arman una tienda con el agente CAÍDO y la bandeja atorada, otra sana, y una sin agente ni trabajo.
 * Lo global (kioskos, outbox) solo se comprueba por su forma: la BD de desarrollo trae sus propios datos.
 */
jest.setTimeout(60_000);

const prisma = new PrismaClient();
const suffix = String(Date.now()).slice(-7);
const hace = (min: number) => new Date(Date.now() - min * 60_000);
let tiendaMala: number;
let tiendaSana: number;
let tiendaVacia: number;
let clienteId: number;
const pedidoIds: number[] = [];
const eventIds: string[] = [];
const kioskoIds: number[] = [];
const monitorIds: number[] = [];
let n = 0;

const actividad = new ActividadWorkers();
const svc = () => new SaludSistemaService(prisma as never, actividad);

async function enBandeja(
  tiendaId: number,
  estado: string,
  o: { creadoHace: number; error?: string; code?: string; intentos?: number; leaseHace?: number },
) {
  const p = await prisma.pedido.create({
    data: {
      numeroPedido: `PD-S${suffix}-${++n}`,
      usuarioId: clienteId,
      tiendaId,
      estado: EstadoPedido.PENDIENTE_PAGO,
      modoEntrega: ModoEntrega.RECOGER_TIENDA,
      clienteNombre: 'C',
      clienteEmail: `s${n}-${suffix}@test.local`,
      subtotal: 1,
      total: 1,
    },
  });
  pedidoIds.push(p.id);
  await prisma.pedidoPendienteEnvio.create({
    data: {
      pedidoId: p.id,
      estado,
      intentos: o.intentos ?? 0,
      createdAt: hace(o.creadoHace),
      ultimoError: o.error ?? null,
      ultimoErrorCode: o.code ?? null,
      ...(o.leaseHace !== undefined ? { leaseUntil: hace(o.leaseHace) } : {}),
    },
  });
  return p;
}

beforeAll(async () => {
  const mk = (n2: string) =>
    prisma.tienda.create({
      data: {
        nombre: `Salud ${n2} ${suffix}`,
        direccion: 'x',
        ciudad: `Ciudad ${n2}`,
        estado: 'x',
      },
    });
  tiendaMala = (await mk('M')).id;
  tiendaSana = (await mk('S')).id;
  tiendaVacia = (await mk('V')).id;
  clienteId = (
    await prisma.usuario.create({
      data: {
        email: `cli-s-${suffix}@test.local`,
        password: 'x',
        nombre: 'C',
        rol: RolUsuario.CLIENTE,
      },
    })
  ).id;
  await prisma.syncCheckpoint.create({
    data: {
      tiendaId: tiendaMala,
      ultimoHeartbeatAt: hace(20),
      agentVersion: '1.2.3',
      lastError: 'Firebird caído',
      lastErrorAt: hace(19),
    },
  });
  await prisma.syncCheckpoint.create({
    // Un agente sano también COMPARA la nube contra el Sistema Comercial: sin esto se vería ámbar ("aún no compara").
    data: {
      tiendaId: tiendaSana,
      ultimoHeartbeatAt: hace(1),
      ultimaConciliacionAt: hace(2),
      ultimaConciliacionRevisados: 3,
    },
  });
  await enBandeja(tiendaMala, 'PENDIENTE', { creadoHace: 20 });
  await enBandeja(tiendaMala, 'RETRY', {
    creadoHace: 45,
    intentos: 4,
    error: 'GRABAR_PEDIDOS: timeout',
    code: 'FB_TIMEOUT',
  });
  await enBandeja(tiendaMala, 'PROCESSING', { creadoHace: 10, leaseHace: 3 });
  await enBandeja(tiendaMala, 'EXPIRADO', { creadoHace: 900 });
  await enBandeja(tiendaSana, 'PENDIENTE', { creadoHace: 1 });
  for (const [estado, i] of [
    ['DEAD_LETTER', 1],
    ['ERROR', 2],
  ] as const) {
    const eventId = `evt-${suffix}-${i}`;
    eventIds.push(eventId);
    await prisma.syncEventInbox.create({
      data: {
        eventId,
        tiendaId: tiendaMala,
        entidad: 'PEDIDO',
        operacion: 'U',
        localId: i,
        estado,
        intentos: 3,
        ultimoErrorCode: 'X',
        mensaje: 'falló',
        payload: {},
      },
    });
  }
  actividad.declarar('estaciones', 300_000, hace(40)); // declarado hace 40 min y jamás corrió → rojo

  // Para la vista del GERENTE: un kiosko caído y una TV de bodega sin latido en CADA una de dos tiendas.
  for (const [tid, marca] of [
    [tiendaMala, 'mala'],
    [tiendaSana, 'sana'],
  ] as const) {
    kioskoIds.push(
      (
        await prisma.kiosko.create({
          data: {
            tiendaId: tid,
            nombre: `K-${marca}-${suffix}`,
            activadoPorId: clienteId,
            deviceTokenHash: `h-${marca}-${suffix}`.padEnd(64, '0'),
            ultimoHeartbeat: hace(120),
          },
        })
      ).id,
    );
    monitorIds.push(
      (
        await prisma.usuario.create({
          data: {
            email: `tv-${marca}-${suffix}@test.local`,
            password: 'x',
            nombre: `TV-${marca}-${suffix}`,
            rol: RolUsuario.BODEGA_MONITOR,
            tiendaId: tid,
            ultimoHeartbeat: hace(40),
          },
        })
      ).id,
    );
  }
});

afterAll(async () => {
  await prisma.kiosko.deleteMany({ where: { id: { in: kioskoIds } } });
  await prisma.usuario.deleteMany({ where: { id: { in: monitorIds } } });
  await prisma.syncEventInbox.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.pedido.deleteMany({ where: { id: { in: pedidoIds } } });
  await prisma.syncCheckpoint.deleteMany({ where: { tiendaId: { in: [tiendaMala, tiendaSana] } } });
  await prisma.tienda.deleteMany({ where: { id: { in: [tiendaMala, tiendaSana, tiendaVacia] } } });
  await prisma.usuario.deleteMany({ where: { id: clienteId } });
  await prisma.$disconnect();
});

const tienda = async (id: number) => (await svc().obtener()).erp.find((e) => e.tienda.id === id)!;

describe('Salud del sistema — el Sistema Comercial por tienda', () => {
  it('agente caído + bandeja atorada: ROJA, con agente, conteos y qué falla', async () => {
    const t = await tienda(tiendaMala);
    expect(t.nivel).toBe('rojo');
    expect(t.agente).toEqual(
      expect.objectContaining({
        estado: 'SIN_LATIDO',
        minutosSinLatido: 20,
        version: '1.2.3',
        ultimoError: 'Firebird caído',
      }),
    );
    expect(t.bandeja).toEqual(
      expect.objectContaining({ pendientes: 1, procesando: 1, reintentos: 1, expirados: 1 }),
    );
    const reintento = t.bandeja.conProblema.find((b) => b.estado === 'RETRY')!;
    expect(reintento).toEqual(
      expect.objectContaining({
        intentos: 4,
        ultimoError: 'GRABAR_PEDIDOS: timeout',
        ultimoErrorCode: 'FB_TIMEOUT',
        minutos: 45,
      }),
    );
    expect(t.bandeja.conProblema.map((b) => b.estado).sort()).toEqual([
      'PENDIENTE',
      'PROCESSING',
      'RETRY',
    ]);
    expect(t.motivos.join(' | ')).toMatch(
      /no reporta hace 20 min.*en la bandeja sin que el agente lo tome.*en reintento.*no terminó/,
    );
  });

  it('agente en línea y un PENDIENTE de 1 min: verde y sin problemas', async () => {
    const t = await tienda(tiendaSana);
    expect(t.nivel).toBe('verde');
    expect(t.agente.estado).toBe('EN_LINEA');
    expect(t.bandeja.conProblema).toEqual([]);
  });

  it('sin agente y sin trabajo: verde ("aún no se instala"), no una falla', async () => {
    const t = await tienda(tiendaVacia);
    expect(t.agente.estado).toBe('NUNCA');
    expect(t.nivel).toBe('verde');
  });
});

describe('Salud del sistema — eventos, workers y el resumen', () => {
  it('eventos de sync: el muerto y el que se reintenta, listos para reprogramar con su eventId', async () => {
    const s = await svc().obtener();
    expect(s.eventosSync.muertos).toBeGreaterThanOrEqual(1);
    expect(s.eventosSync.error).toBeGreaterThanOrEqual(1);
    const mio = s.eventosSync.recientes.find((e) => e.eventId === `evt-${suffix}-1`);
    expect(mio).toEqual(
      expect.objectContaining({ estado: 'DEAD_LETTER', tiendaId: tiendaMala, entidad: 'PEDIDO' }),
    );
  });

  it('un worker declarado hace 40 min que nunca corrió sale ROJO en la lista y en los motivos', async () => {
    const s = await svc().obtener();
    expect(s.workers.find((w) => w.nombre === 'estaciones')).toEqual(
      expect.objectContaining({ nivel: 'rojo', ultimaCorridaAt: null }),
    );
    expect(s.motivos.some((m) => m.area === 'workers' && m.nivel === 'rojo')).toBe(true);
  });

  it('el nivel general es el peor, los motivos van del rojo al ámbar y llevan la ciudad', async () => {
    const s = await svc().obtener();
    expect(s.nivel).toBe('rojo');
    const niveles = s.motivos.map((m) => m.nivel);
    expect(niveles).toEqual([...niveles].sort((a, b) => (a === b ? 0 : a === 'rojo' ? -1 : 1)));
    expect(s.motivos.some((m) => m.area === 'agente' && m.texto.startsWith('Ciudad M: '))).toBe(
      true,
    );
  });

  it('la forma de lo global (kioskos, pantallas, outbox) está siempre', async () => {
    const s = await svc().obtener();
    expect(s.kioskos).toEqual(
      expect.objectContaining({
        activos: expect.any(Number),
        caidos: expect.any(Array),
        sinCredencial: expect.any(Number),
      }),
    );
    expect(Array.isArray(s.pantallas)).toBe(true);
    expect(typeof s.outbox.sinEmitir).toBe('number');
  });
});

describe('Salud para el GERENTE — acotada a SU tienda y sin lo técnico', () => {
  const paraGerente = (id: number) => svc().obtenerParaGerente(id);

  it('solo trae SU tienda: ni su ERP, ni sus eventos, ni sus kioskos ni su TV son de otra', async () => {
    const g = await paraGerente(tiendaMala);
    expect(g.erp.map((e) => e.tienda.id)).toEqual([tiendaMala]);
    expect(g.eventosSync).toEqual({ error: 1, muertos: 1 });
    expect(g.kioskos.caidos.map((k) => k.nombre)).toEqual([`K-mala-${suffix}`]);
    expect(g.pantallas.map((p) => p.nombre)).toEqual([`TV-mala-${suffix}`]);

    const sana = await paraGerente(tiendaSana);
    expect(sana.erp.map((e) => e.tienda.id)).toEqual([tiendaSana]);
    // Los eventos fallidos son de la OTRA tienda: aquí no existen.
    expect(sana.eventosSync).toEqual({ error: 0, muertos: 0 });
    expect(sana.kioskos.caidos.map((k) => k.nombre)).toEqual([`K-sana-${suffix}`]);
    expect(sana.pantallas.map((p) => p.nombre)).toEqual([`TV-sana-${suffix}`]);
  });

  it('dice lo que importa (agente, cuántos esperan, qué pedidos) pero NO el texto de los errores del ERP', async () => {
    const g = await paraGerente(tiendaMala);
    const e = g.erp[0];
    expect(e.nivel).toBe('rojo');
    expect(e.agente).toEqual({
      estado: 'SIN_LATIDO',
      ultimoLatidoAt: expect.any(String),
      minutosSinLatido: 20,
      version: '1.2.3',
    });
    expect(e.bandeja).toEqual(
      expect.objectContaining({ pendientes: 1, procesando: 1, reintentos: 1, expirados: 1 }),
    );
    expect(e.bandeja.conProblema.map((b) => b.estado).sort()).toEqual([
      'PENDIENTE',
      'PROCESSING',
      'RETRY',
    ]);
    const crudo = JSON.stringify(g);
    for (const secreto of ['Firebird caído', 'GRABAR_PEDIDOS', 'FB_TIMEOUT', 'falló']) {
      expect(crudo).not.toContain(secreto);
    }
    expect(crudo).not.toMatch(/ultimoError|mensaje/);
  });

  it('no incluye lo del SISTEMA: ni outbox ni barridos, ni motivos de esas áreas', async () => {
    const g = await paraGerente(tiendaMala);
    expect(g).not.toHaveProperty('outbox');
    expect(g).not.toHaveProperty('workers');
    expect(g.motivos.filter((m) => m.area === 'outbox' || m.area === 'workers')).toEqual([]);
    // El barrido "rojo" de la prueba (declarado hace 40 min y sin correr) sí cuenta en la vista del ADMIN.
    const admin = await svc().obtener();
    expect(admin.motivos.some((m) => m.area === 'workers')).toBe(true);
  });

  it('una tienda sin agente ni trabajo no se pinta rota (igual que en la vista del ADMIN)', async () => {
    const g = await paraGerente(tiendaVacia);
    expect(g.erp[0].agente.estado).toBe('NUNCA');
    expect(g.erp[0].nivel).toBe('verde');
  });
});

describe('Salud — la conciliación con el Sistema Comercial', () => {
  const paraGerente = (id: number) => svc().obtenerParaGerente(id);
  const abrir = async (tipo: string, detalle: object, o: { curado?: boolean } = {}) => {
    const p = await enBandeja(tiendaSana, 'PROCESADO', { creadoHace: 5 });
    await prisma.pedidoPendienteEnvio.update({
      where: { pedidoId: p.id },
      data: { externalIdPEDIDOS: 1_000_000_000 + p.id, externalFolio: '0000099999' },
    });
    await prisma.conciliacionHallazgo.create({
      data: {
        tiendaId: tiendaSana,
        pedidoId: p.id,
        tipo,
        detalle,
        curado: o.curado ?? false,
        resueltoAt: o.curado ? new Date() : null,
      },
    });
    return p;
  };
  afterEach(() => prisma.conciliacionHallazgo.deleteMany({ where: { tiendaId: tiendaSana } }));

  it('sin diferencias y comparada hace 2 min: verde, y dice cuándo y cuántos se revisaron', async () => {
    const c = (await tienda(tiendaSana)).conciliacion;
    expect(c).toMatchObject({ revisados: 3, corregidas24h: 0, abiertas: [] });
    expect(c.minutosDesde).toBe(2);
  });

  it('dinero que no coincide: la tienda se pone ROJA, con el texto, el folio del ERP y el detalle de cada lado', async () => {
    const p = await abrir('COBRADO_Y_CANCELADO', { nube: 'CANCELADO', erp: { finalizada: true } });
    const t = await tienda(tiendaSana);
    expect(t.nivel).toBe('rojo');
    expect(t.motivos.join(' ')).toContain('con dinero que no coincide con el Sistema Comercial');
    expect(t.conciliacion.abiertas).toHaveLength(1);
    expect(t.conciliacion.abiertas[0]).toMatchObject({
      pedidoId: p.id,
      folio: '0000099999',
      tipo: 'COBRADO_Y_CANCELADO',
      titulo: 'Cobrado y cancelado',
      detalle: { nube: 'CANCELADO', erp: { finalizada: true } },
    });
    expect((await svc().obtener()).motivos.some((m) => m.area === 'conciliacion')).toBe(true);
  });

  it('lo que la nube corrigió SOLA se cuenta (24 h) pero NO enciende ninguna alerta', async () => {
    await abrir('COBRO_PERDIDO', { nube: 'PENDIENTE_PAGO' }, { curado: true });
    const t = await tienda(tiendaSana);
    expect(t.conciliacion).toMatchObject({ corregidas24h: 1, abiertas: [] });
    expect(t.nivel).toBe('verde');
  });

  it('un hallazgo ya resuelto no cuenta como abierto', async () => {
    const p = await abrir('TOTAL_DISTINTO', {});
    await prisma.conciliacionHallazgo.updateMany({
      where: { pedidoId: p.id },
      data: { resueltoAt: new Date() },
    });
    expect((await tienda(tiendaSana)).conciliacion.abiertas).toEqual([]);
  });

  it('el GERENTE ve qué pedido y qué pasa, pero NO el detalle crudo de cada lado', async () => {
    await abrir('COBRADO_Y_CANCELADO', { nube: 'CANCELADO', secreto: 'swcancel=false total=999' });
    const g = await paraGerente(tiendaSana);
    expect(g.erp[0].conciliacion.abiertas[0]).toMatchObject({
      tipo: 'COBRADO_Y_CANCELADO',
      folio: '0000099999',
      que: expect.stringContaining('Hay dinero'),
    });
    expect(JSON.stringify(g)).not.toContain('swcancel=false');
    expect(g.erp[0].nivel).toBe('rojo');
  });

  it('un agente en línea que NUNCA ha comparado se ve ámbar; sin agente no se duplica el aviso', async () => {
    // tiendaVacia no tiene agente: no hay aviso de conciliación (lo diría el del agente, y aquí ni eso).
    expect((await tienda(tiendaVacia)).nivel).toBe('verde');

    await prisma.syncCheckpoint.create({
      data: { tiendaId: tiendaVacia, ultimoHeartbeatAt: hace(1) },
    });
    try {
      const t = await tienda(tiendaVacia);
      expect(t.nivel).toBe('ambar');
      expect(t.motivos.join(' ')).toContain('aún no compara');
      expect(t.conciliacion).toMatchObject({ ultimaAt: null, minutosDesde: null });
    } finally {
      await prisma.syncCheckpoint.delete({ where: { tiendaId: tiendaVacia } });
    }
  });
});

describe('Salud — los folios que esperan al Sistema Comercial (parte B)', () => {
  const paraGerente = (id: number) => svc().obtenerParaGerente(id);

  /** Un pedido que bodega ya cerró y que espera su folio, con su solicitud creada hace `hace` minutos. */
  async function esperandoFolio(
    tiendaId: number,
    o: {
      hace: number;
      error?: string;
      estadoPedido?: EstadoPedido;
      folioErp?: string;
      estado?: string;
    },
  ) {
    const p = await prisma.pedido.create({
      data: {
        numeroPedido: `PD-F${suffix}-${++n}`,
        usuarioId: clienteId,
        tiendaId,
        estado: o.estadoPedido ?? EstadoPedido.REVISADO,
        modoEntrega: ModoEntrega.RECOGER_TIENDA,
        clienteNombre: 'C',
        clienteEmail: `f${n}-${suffix}@test.local`,
        subtotal: 1,
        total: 1,
        folioErp: o.folioErp ?? null,
      },
    });
    pedidoIds.push(p.id);
    await prisma.pedidoFolioSolicitud.create({
      data: {
        pedidoId: p.id,
        tiendaId,
        estado: o.estado ?? 'PENDIENTE',
        createdAt: hace(o.hace),
        ultimoError: o.error ?? null,
        intentos: o.error ? 3 : 0,
      },
    });
    return p;
  }
  afterEach(() =>
    prisma.pedidoFolioSolicitud.deleteMany({
      where: { tiendaId: { in: [tiendaMala, tiendaSana, tiendaVacia] } },
    }),
  );

  it('sin solicitudes: la sección existe y está en cero', async () => {
    const t = await tienda(tiendaSana);
    expect(t.folios).toEqual({ sinAsignar: 0, masViejaMin: null, conError: 0, conProblema: [] });
  });

  it('un folio recién pedido (segundos) es lo normal: verde', async () => {
    await esperandoFolio(tiendaSana, { hace: 0 });
    const t = await tienda(tiendaSana);
    expect(t.folios.sinAsignar).toBe(1);
    expect(t.nivel).toBe('verde');
    expect(t.folios.conProblema).toEqual([]);
  });

  it('un pedido que lleva 12 min sin folio pone la tienda en ROJO y dice cuál es', async () => {
    const p = await esperandoFolio(tiendaSana, { hace: 12 });
    const t = await tienda(tiendaSana);
    expect(t.nivel).toBe('rojo');
    expect(t.folios).toEqual(
      expect.objectContaining({ sinAsignar: 1, masViejaMin: 12, conError: 0 }),
    );
    expect(t.folios.conProblema).toEqual([
      expect.objectContaining({ pedidoId: p.id, numeroPedido: p.numeroPedido, minutos: 12 }),
    ]);
    expect(t.motivos.join(' | ')).toMatch(/1 pedido sin folio del Sistema Comercial/);
    const general = await svc().obtener();
    expect(general.motivos.some((m) => m.area === 'folios' && m.nivel === 'rojo')).toBe(true);
  });

  it('lo que el agente intentó y falló se ve (ámbar) con el texto del error, y cuenta aunque sea reciente', async () => {
    await esperandoFolio(tiendaSana, {
      hace: 1,
      error: 'CONSECUTIVOS: la tienda 9 no tiene consecutivo de PEDIDOS',
    });
    const t = await tienda(tiendaSana);
    expect(t.nivel).toBe('ambar');
    expect(t.folios.conError).toBe(1);
    expect(t.folios.conProblema[0].ultimoError).toMatch(/no tiene consecutivo/);
  });

  it('un pedido CANCELADO, o que ya recibió su folio, no es una espera', async () => {
    await esperandoFolio(tiendaSana, { hace: 30, estadoPedido: EstadoPedido.CANCELADO });
    await esperandoFolio(tiendaSana, {
      hace: 30,
      folioErp: String(Date.now()).slice(-10).padStart(10, '0'),
      estado: 'ASIGNADO',
    });
    const t = await tienda(tiendaSana);
    expect(t.folios.sinAsignar).toBe(0);
    expect(t.nivel).toBe('verde');
  });

  it('solo cuenta las de SU tienda', async () => {
    await esperandoFolio(tiendaMala, { hace: 30 });
    const sana = await tienda(tiendaSana);
    expect(sana.folios.sinAsignar).toBe(0);
    expect((await tienda(tiendaMala)).folios.sinAsignar).toBe(1);
  });

  it('el GERENTE ve cuántos esperan y cuáles, pero NO el texto del error del agente', async () => {
    await esperandoFolio(tiendaSana, { hace: 5, error: 'C:\\datos\\sistema.fdb: lock time-out' });
    const g = await paraGerente(tiendaSana);
    expect(g.erp[0].folios.sinAsignar).toBe(1);
    expect(g.erp[0].folios.conProblema).toHaveLength(1);
    expect(JSON.stringify(g)).not.toContain('sistema.fdb');
    expect(Object.keys(g.erp[0].folios.conProblema[0])).not.toContain('ultimoError');
  });
});
