import { Injectable, Optional } from '@nestjs/common';
import { Prisma, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActividadWorkers } from '../../common/actividad-workers';
import { calcularSaludKiosko } from '../kiosko/kiosko-salud';
import { minutosDesde, peorNivel, type Nivel } from './torre-control.util';
import { redactarParaGerente, type SaludGerente } from './salud-gerente';
import { textoDeHallazgo } from '../sync/conciliacion.util';
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
  type EstadoAgente,
  type MotivoSalud,
  UMBRALES_SALUD,
} from './salud-sistema.util';

export interface SaludErpTienda {
  tienda: { id: number; nombre: string; ciudad: string };
  nivel: Nivel;
  motivos: string[];
  agente: {
    estado: EstadoAgente;
    ultimoLatidoAt: string | null;
    minutosSinLatido: number | null;
    version: string | null;
    ultimoError: string | null;
    ultimoErrorAt: string | null;
  };
  bandeja: {
    pendientes: number;
    procesando: number;
    reintentos: number;
    expirados: number;
    /** Los que fallan o esperan de más: lo que el ADMIN debe poder leer sin abrir la BD. */
    conProblema: Array<{
      pedidoId: number;
      numeroPedido: string;
      estado: string;
      intentos: number;
      minutos: number;
      ultimoError: string | null;
      ultimoErrorCode: string | null;
    }>;
  };
  /** Oct 2026 (parte B): los pedidos que esperan su folio del Sistema Comercial (el agente lo reserva en su siguiente ciclo). */
  folios: {
    sinAsignar: number;
    masViejaMin: number | null;
    conError: number;
    /** Los que esperan de más o fallaron: con el texto del error del agente (solo lo ve el ADMIN). */
    conProblema: Array<{
      pedidoId: number;
      numeroPedido: string;
      intentos: number;
      minutos: number;
      ultimoError: string | null;
    }>;
  };
  /** La conciliación activa: el agente compara la nube contra el Sistema Comercial pedido por pedido. */
  conciliacion: {
    ultimaAt: string | null;
    minutosDesde: number | null;
    revisados: number | null;
    /** Lo que la nube corrigió SOLA en las últimas 24 h (un cobro o una cancelación que no supo). */
    corregidas24h: number;
    /** Lo que sigue sin cuadrar y pide a una persona. */
    abiertas: Array<{
      id: number;
      pedidoId: number;
      numeroPedido: string;
      folio: string | null;
      tipo: string;
      titulo: string;
      que: string;
      desdeAt: string;
      minutos: number;
      /** Qué dice cada lado (estado, SWCANCEL/FINALIZADA, totales). Solo lo ve el ADMIN. */
      detalle: unknown;
    }>;
  };
}

export interface SaludSistema {
  generadoAt: string;
  nivel: Nivel;
  motivos: MotivoSalud[];
  erp: SaludErpTienda[];
  /** Eventos ERP→nube fallidos; cada uno se puede reprogramar con `POST sync/admin/events/:eventId/replay` (ya existe). */
  eventosSync: {
    error: number;
    muertos: number;
    recientes: Array<{
      eventId: string;
      tiendaId: number;
      entidad: string;
      estado: string;
      intentos: number;
      ultimoErrorCode: string | null;
      mensaje: string | null;
      createdAt: string;
    }>;
  };
  kioskos: {
    activos: number;
    caidos: Array<{ id: number; nombre: string; tienda: string; ultimoHeartbeat: string | null }>;
    sinCredencial: number;
  };
  /** TVs de bodega (son las únicas pantallas que reportan latido). */
  pantallas: Array<{
    usuarioId: number;
    nombre: string;
    tiendaId: number | null;
    minutosSinLatido: number | null;
    enLinea: boolean;
  }>;
  outbox: { sinEmitir: number; masViejoMin: number | null };
  workers: Array<{
    nombre: string;
    periodoSeg: number;
    ultimaCorridaAt: string | null;
    minutosDesdeCorrida: number;
    ultimoError: string | null;
    nivel: Nivel;
  }>;
}

/**
 * N3 (oct 2026): la salud del sistema, para el ADMIN. Ver `salud-sistema.util.ts` (qué es "sano") — aquí solo se juntan
 * los datos con pocas consultas para todas las tiendas. No ejecuta ninguna acción: el único reintento que existe
 * (`sync/admin/events/:eventId/replay`) lo llama la pantalla.
 */
@Injectable()
export class SaludSistemaService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly actividad?: ActividadWorkers,
  ) {}

  /** La salud de UNA tienda para su GERENTE: acotada a su tienda y sin lo técnico (ver `redactarParaGerente`). */
  async obtenerParaGerente(tiendaId: number, ahora: Date = new Date()): Promise<SaludGerente> {
    return redactarParaGerente(await this.obtener(ahora, tiendaId));
  }

  /**
   * `tiendaId`: acota todo a UNA tienda (kioskos, TVs, agente, bandeja y eventos de esa tienda) y omite lo que es
   * del SISTEMA y no de una tienda (outbox de realtime y barridos). Es la base de la vista del GERENTE
   * (`obtenerParaGerente`); sin él es la salud completa del ADMIN.
   */
  async obtener(ahora: Date = new Date(), tiendaId?: number): Promise<SaludSistema> {
    const tiendas = await this.prisma.tienda.findMany({
      where: { activa: true, ...(tiendaId ? { id: tiendaId } : {}) },
      orderBy: { id: 'asc' },
      select: { id: true, nombre: true, ciudad: true },
    });
    const ids = tiendas.map((t) => t.id);

    const [
      checkpoints,
      bandeja,
      expirados,
      eventosConteo,
      eventosRecientes,
      kioskos,
      monitores,
      outbox,
      hallazgosAbiertos,
      corregidas,
      solicitudesDeFolio,
    ] = await Promise.all([
      this.prisma.syncCheckpoint.findMany({ where: { tiendaId: { in: ids } } }),
      this.prisma.pedidoPendienteEnvio.findMany({
        where: {
          estado: { in: ['PENDIENTE', 'PROCESSING', 'RETRY'] },
          // Un pedido cancelado en la nube nunca llegará al ERP (el poll del agente lo ignora): no es una bandeja atorada.
          pedido: { tiendaId: { in: ids }, estado: { not: 'CANCELADO' } },
        },
        select: {
          estado: true,
          intentos: true,
          createdAt: true,
          leaseUntil: true,
          ultimoError: true,
          ultimoErrorCode: true,
          pedido: { select: { id: true, numeroPedido: true, tiendaId: true } },
        },
      }),
      this.prisma.$queryRaw<Array<{ tiendaId: number; n: bigint }>>(Prisma.sql`
          SELECT p.tienda_id AS "tiendaId", count(*) AS n
            FROM pedidos_pendientes_envio e JOIN pedidos p ON p.id = e.pedido_id
           WHERE e.estado = 'EXPIRADO' GROUP BY p.tienda_id`),
      this.prisma.syncEventInbox.groupBy({
        by: ['estado'],
        where: { estado: { in: ['ERROR', 'DEAD_LETTER'] }, tiendaId: { in: ids } },
        _count: true,
      }),
      this.prisma.syncEventInbox.findMany({
        where: { estado: { in: ['ERROR', 'DEAD_LETTER'] }, tiendaId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          eventId: true,
          tiendaId: true,
          entidad: true,
          estado: true,
          intentos: true,
          ultimoErrorCode: true,
          mensaje: true,
          createdAt: true,
        },
      }),
      this.prisma.kiosko.findMany({
        where: tiendaId ? { tiendaId } : undefined,
        select: {
          id: true,
          nombre: true,
          estado: true,
          ultimoHeartbeat: true,
          primerConexionAt: true,
          desactivadoAt: true,
          deviceTokenHash: true,
          tienda: { select: { nombre: true } },
        },
      }),
      this.prisma.usuario.findMany({
        where: {
          rol: RolUsuario.BODEGA_MONITOR,
          activo: true,
          ...(tiendaId ? { tiendaId } : {}),
        },
        select: { id: true, nombre: true, tiendaId: true, ultimoHeartbeat: true },
      }),
      // El outbox es del sistema entero: no pertenece a una tienda, así que una vista acotada no lo consulta.
      tiendaId
        ? Promise.resolve(null)
        : this.prisma.realtimeEventOutbox.aggregate({
            where: { emitidoAt: null },
            _count: true,
            _min: { createdAt: true },
          }),
      this.prisma.conciliacionHallazgo.findMany({
        where: { tiendaId: { in: ids }, resueltoAt: null },
        orderBy: { primeraVezAt: 'asc' },
        take: 200,
        select: {
          id: true,
          tiendaId: true,
          tipo: true,
          detalle: true,
          primeraVezAt: true,
          pedido: {
            select: {
              id: true,
              numeroPedido: true,
              pendienteEnvio: { select: { externalFolio: true } },
            },
          },
        },
      }),
      this.prisma.conciliacionHallazgo.groupBy({
        by: ['tiendaId'],
        where: {
          tiendaId: { in: ids },
          curado: true,
          primeraVezAt: { gte: new Date(ahora.getTime() - 24 * 3_600_000) },
        },
        _count: true,
      }),
      // Oct 2026 (parte B): los pedidos que esperan su folio. Un cancelado ya no lo necesita, y uno que lo recibió por el
      // respaldo de GRABAR_PEDIDOS (la solicitud se cierra con él) tampoco.
      this.prisma.pedidoFolioSolicitud.findMany({
        where: {
          tiendaId: { in: ids },
          estado: { not: 'ASIGNADO' },
          pedido: { estado: { not: 'CANCELADO' }, folioErp: null },
        },
        select: {
          tiendaId: true,
          intentos: true,
          createdAt: true,
          ultimoError: true,
          pedido: { select: { id: true, numeroPedido: true } },
        },
      }),
    ]);

    const motivos: MotivoSalud[] = [];
    const agrega = (
      area: MotivoSalud['area'],
      r: { motivos: Array<{ nivel: 'ambar' | 'rojo'; texto: string }> },
      prefijo = '',
    ) =>
      motivos.push(
        ...r.motivos.map((m) => ({ area, nivel: m.nivel, texto: `${prefijo}${m.texto}` })),
      );

    // ── ERP por tienda ─────────────────────────────────────────
    const erp: SaludErpTienda[] = tiendas.map((t) => {
      const cp = checkpoints.find((c) => c.tiendaId === t.id);
      const delaTienda = bandeja.filter((b) => b.pedido.tiendaId === t.id);
      const pend = delaTienda.filter((b) => b.estado === 'PENDIENTE');
      const reint = delaTienda.filter((b) => b.estado === 'RETRY');
      const proc = delaTienda.filter((b) => b.estado === 'PROCESSING');
      const vencidos = proc.filter((b) => b.leaseUntil && b.leaseUntil < ahora);
      const masViejo = (xs: typeof delaTienda) =>
        xs.reduce<(typeof delaTienda)[number] | null>(
          (m, x) => (!m || x.createdAt < m.createdAt ? x : m),
          null,
        );
      const vPend = masViejo(pend);
      const vReint = masViejo(reint);

      const sinLatido = cp?.ultimoHeartbeatAt ? minutosDesde(cp.ultimoHeartbeatAt, ahora) : null;
      const agente = evaluarAgente(sinLatido, delaTienda.length > 0);
      const evBandeja = evaluarBandeja({
        pendienteMasViejoMin: vPend ? minutosDesde(vPend.createdAt, ahora) : null,
        pendienteReferencia: vPend?.pedido.numeroPedido ?? null,
        reintentos: reint.length,
        reintentoMasViejoMin: vReint ? minutosDesde(vReint.createdAt, ahora) : null,
        leaseVencidos: vencidos.length,
      });
      // La conciliación: lo que sigue sin cuadrar (abierto) y cuándo se comparó por última vez.
      const abiertasT = hallazgosAbiertos
        .filter((h) => h.tiendaId === t.id)
        .map((h) => ({ h, ...textoDeHallazgo(h.tipo) }));
      const minDesdeConc = cp?.ultimaConciliacionAt
        ? minutosDesde(cp.ultimaConciliacionAt, ahora)
        : null;
      const evConc = evaluarConciliacion({
        minutosDesdeUltima: minDesdeConc,
        agenteEnLinea: agente.estado === 'EN_LINEA',
        abiertos: abiertasT.map((a) => ({
          tipo: a.h.tipo,
          titulo: a.titulo,
          numeroPedido: a.h.pedido.numeroPedido,
        })),
      });
      // Los folios: pedidos cuyo surtido bodega cerró y que aún no tienen su número del Sistema Comercial.
      const foliosT = solicitudesDeFolio
        .filter((f) => f.tiendaId === t.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const foliosConError = foliosT.filter((f) => f.ultimoError);
      const evFolios = evaluarFolios({
        sinAsignar: foliosT.length,
        masViejaMin: foliosT.length ? minutosDesde(foliosT[0].createdAt, ahora) : null,
        referencia: foliosT[0]?.pedido.numeroPedido ?? null,
        conError: foliosConError.length,
      });
      const prefijo = `${t.ciudad}: `;
      agrega('agente', agente, prefijo);
      agrega('bandeja', evBandeja, prefijo);
      agrega('folios', evFolios, prefijo);
      agrega('conciliacion', evConc, prefijo);

      return {
        tienda: t,
        nivel: peorNivel([agente.nivel, evBandeja.nivel, evFolios.nivel, evConc.nivel]),
        motivos: [
          ...agente.motivos,
          ...evBandeja.motivos,
          ...evFolios.motivos,
          ...evConc.motivos,
        ].map((m) => m.texto),
        agente: {
          estado: agente.estado,
          ultimoLatidoAt: cp?.ultimoHeartbeatAt?.toISOString() ?? null,
          minutosSinLatido: sinLatido,
          version: cp?.agentVersion ?? null,
          ultimoError: cp?.lastError ?? null,
          ultimoErrorAt: cp?.lastErrorAt?.toISOString() ?? null,
        },
        bandeja: {
          pendientes: pend.length,
          procesando: proc.length,
          reintentos: reint.length,
          expirados: Number(expirados.find((e) => e.tiendaId === t.id)?.n ?? 0),
          conProblema: [
            ...reint,
            ...vencidos,
            ...pend.filter((p) => (minutosDesde(p.createdAt, ahora) ?? 0) >= 5),
          ]
            .slice(0, 5)
            .map((b) => ({
              pedidoId: b.pedido.id,
              numeroPedido: b.pedido.numeroPedido,
              estado: b.estado,
              intentos: b.intentos,
              minutos: minutosDesde(b.createdAt, ahora) ?? 0,
              ultimoError: b.ultimoError,
              ultimoErrorCode: b.ultimoErrorCode,
            })),
        },
        folios: {
          sinAsignar: foliosT.length,
          masViejaMin: foliosT.length ? minutosDesde(foliosT[0].createdAt, ahora) : null,
          conError: foliosConError.length,
          conProblema: [
            ...foliosConError,
            ...foliosT.filter(
              (f) =>
                !f.ultimoError &&
                (minutosDesde(f.createdAt, ahora) ?? 0) >= UMBRALES_SALUD.folios.ambar,
            ),
          ]
            .slice(0, 5)
            .map((f) => ({
              pedidoId: f.pedido.id,
              numeroPedido: f.pedido.numeroPedido,
              intentos: f.intentos,
              minutos: minutosDesde(f.createdAt, ahora) ?? 0,
              ultimoError: f.ultimoError,
            })),
        },
        conciliacion: {
          ultimaAt: cp?.ultimaConciliacionAt?.toISOString() ?? null,
          minutosDesde: minDesdeConc,
          revisados: cp?.ultimaConciliacionRevisados ?? null,
          corregidas24h: corregidas.find((c) => c.tiendaId === t.id)?._count ?? 0,
          abiertas: abiertasT.slice(0, 20).map((a) => ({
            id: a.h.id,
            pedidoId: a.h.pedido.id,
            numeroPedido: a.h.pedido.numeroPedido,
            folio: a.h.pedido.pendienteEnvio?.externalFolio?.trim() || null,
            tipo: a.h.tipo,
            titulo: a.titulo,
            que: a.que,
            desdeAt: a.h.primeraVezAt.toISOString(),
            minutos: minutosDesde(a.h.primeraVezAt, ahora) ?? 0,
            detalle: a.h.detalle,
          })),
        },
      };
    });

    // ── eventos de sync ────────────────────────────────────────
    const cuenta = (e: string) => eventosConteo.find((c) => c.estado === e)?._count ?? 0;
    const eventos = { error: cuenta('ERROR'), muertos: cuenta('DEAD_LETTER') };
    agrega('eventos', evaluarEventos(eventos));

    // ── kioskos y pantallas ────────────────────────────────────
    const ahoraMs = ahora.getTime();
    const conSalud = kioskos.map((k) => ({ k, salud: calcularSaludKiosko(k, ahoraMs) }));
    const debenLatir = conSalud.filter(({ k }) => k.estado === 'ACTIVO' && k.deviceTokenHash);
    const caidos = conSalud.filter((x) => x.salud === 'CAIDA');
    const sinCredencial = conSalud.filter((x) => x.salud === 'SIN_CREDENCIAL').length;
    agrega(
      'kioskos',
      evaluarKioskos({ activos: debenLatir.length, caidos: caidos.length, sinCredencial }),
    );

    const pantallas = monitores.map((m) => {
      const min = m.ultimoHeartbeat ? minutosDesde(m.ultimoHeartbeat, ahora) : null;
      const ev = evaluarPantalla(min);
      if (ev.nivel !== 'verde') {
        motivos.push({
          area: 'pantallas',
          nivel: ev.nivel,
          texto: `La TV de bodega «${m.nombre}» no reporta hace ${min} min`,
        });
      }
      return {
        usuarioId: m.id,
        nombre: m.nombre,
        tiendaId: m.tiendaId,
        minutosSinLatido: min,
        enLinea: ev.enLinea,
      };
    });

    // ── outbox y workers ───────────────────────────────────────
    const out = {
      sinEmitir: outbox?._count ?? 0,
      masViejoMin: outbox?._min.createdAt ? minutosDesde(outbox._min.createdAt, ahora) : null,
    };
    if (outbox) agrega('outbox', evaluarOutbox(out));

    // Los barridos tampoco son de una tienda: solo en la vista completa.
    const workers = (tiendaId ? [] : (this.actividad?.instantanea() ?? [])).map((w) => {
      const ev = evaluarWorker(w, ahora);
      agrega('workers', ev);
      return {
        nombre: w.nombre,
        periodoSeg: Math.round(w.periodoMs / 1000),
        ultimaCorridaAt: w.ultimaCorridaAt?.toISOString() ?? null,
        minutosDesdeCorrida: ev.minutosDesdeCorrida,
        ultimoError: w.ultimoError,
        nivel: ev.nivel,
      };
    });

    motivos.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'rojo' ? -1 : 1));
    return {
      generadoAt: ahora.toISOString(),
      nivel: peorNivel(motivos.map((m) => m.nivel)),
      motivos,
      erp,
      eventosSync: {
        ...eventos,
        recientes: eventosRecientes.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      },
      kioskos: {
        activos: debenLatir.length,
        caidos: caidos.map(({ k }) => ({
          id: k.id,
          nombre: k.nombre,
          tienda: k.tienda.nombre,
          ultimoHeartbeat: k.ultimoHeartbeat?.toISOString() ?? null,
        })),
        sinCredencial,
      },
      pantallas,
      outbox: out,
      workers,
    };
  }
}
