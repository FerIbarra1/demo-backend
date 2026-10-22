import type { SaludSistema } from './salud-sistema.service';
import type { MotivoSalud } from './salud-sistema.util';
import type { Nivel } from './torre-control.util';

/**
 * La salud que ve el GERENTE de UNA tienda (oct 2026): cuántos pedidos esperan al Sistema Comercial, si el agente
 * late, qué kioskos y TV de su tienda están caídos. NO lleva lo técnico: el texto crudo de los errores del ERP
 * (`ultimoError`, `mensaje`) puede traer rutas internas y nombres de tablas, y el único botón que actúa sobre el
 * ERP (`replay` de un evento) es del ADMIN. Tampoco el outbox de realtime ni los barridos: son del SISTEMA, no de
 * una tienda.
 */
export interface SaludGerente {
  generadoAt: string;
  nivel: Nivel;
  motivos: MotivoSalud[];
  erp: Array<{
    tienda: SaludSistema['erp'][number]['tienda'];
    nivel: Nivel;
    motivos: string[];
    agente: {
      estado: SaludSistema['erp'][number]['agente']['estado'];
      ultimoLatidoAt: string | null;
      minutosSinLatido: number | null;
      version: string | null;
    };
    bandeja: {
      pendientes: number;
      procesando: number;
      reintentos: number;
      expirados: number;
      conProblema: Array<{
        pedidoId: number;
        numeroPedido: string;
        estado: string;
        intentos: number;
        minutos: number;
      }>;
    };
    /** Sin el texto del error del agente: solo cuántos esperan su folio, cuánto llevan y cuáles. */
    folios: {
      sinAsignar: number;
      masViejaMin: number | null;
      conError: number;
      conProblema: Array<{
        pedidoId: number;
        numeroPedido: string;
        intentos: number;
        minutos: number;
      }>;
    };
    /** Sin `detalle` (los estados y montos crudos de cada lado): solo qué pasa, con qué pedido y desde cuándo. */
    conciliacion: {
      ultimaAt: string | null;
      minutosDesde: number | null;
      corregidas24h: number;
      abiertas: Array<{
        pedidoId: number;
        numeroPedido: string;
        folio: string | null;
        tipo: string;
        titulo: string;
        que: string;
        minutos: number;
      }>;
    };
  }>;
  /** Solo cuántos: sin mensajes ni códigos del ERP. */
  eventosSync: { error: number; muertos: number };
  kioskos: SaludSistema['kioskos'];
  pantallas: SaludSistema['pantallas'];
}

/** Áreas del SISTEMA (no de una tienda): nunca llegan al gerente. */
const AREAS_DEL_SISTEMA: ReadonlyArray<MotivoSalud['area']> = ['outbox', 'workers'];

/**
 * Se arma por LISTA BLANCA (campo por campo), no quitando lo prohibido: un campo técnico que mañana se agregue a
 * `SaludSistema` no llega al gerente por accidente. `salud-gerente.spec.ts` fija las llaves exactas.
 */
export function redactarParaGerente(s: SaludSistema): SaludGerente {
  return {
    generadoAt: s.generadoAt,
    nivel: s.nivel,
    motivos: s.motivos.filter((m) => !AREAS_DEL_SISTEMA.includes(m.area)),
    erp: s.erp.map((e) => ({
      tienda: e.tienda,
      nivel: e.nivel,
      motivos: e.motivos,
      agente: {
        estado: e.agente.estado,
        ultimoLatidoAt: e.agente.ultimoLatidoAt,
        minutosSinLatido: e.agente.minutosSinLatido,
        version: e.agente.version,
      },
      bandeja: {
        pendientes: e.bandeja.pendientes,
        procesando: e.bandeja.procesando,
        reintentos: e.bandeja.reintentos,
        expirados: e.bandeja.expirados,
        conProblema: e.bandeja.conProblema.map((b) => ({
          pedidoId: b.pedidoId,
          numeroPedido: b.numeroPedido,
          estado: b.estado,
          intentos: b.intentos,
          minutos: b.minutos,
        })),
      },
      folios: {
        sinAsignar: e.folios.sinAsignar,
        masViejaMin: e.folios.masViejaMin,
        conError: e.folios.conError,
        conProblema: e.folios.conProblema.map((f) => ({
          pedidoId: f.pedidoId,
          numeroPedido: f.numeroPedido,
          intentos: f.intentos,
          minutos: f.minutos,
        })),
      },
      conciliacion: {
        ultimaAt: e.conciliacion.ultimaAt,
        minutosDesde: e.conciliacion.minutosDesde,
        corregidas24h: e.conciliacion.corregidas24h,
        abiertas: e.conciliacion.abiertas.map((a) => ({
          pedidoId: a.pedidoId,
          numeroPedido: a.numeroPedido,
          folio: a.folio,
          tipo: a.tipo,
          titulo: a.titulo,
          que: a.que,
          minutos: a.minutos,
        })),
      },
    })),
    eventosSync: { error: s.eventosSync.error, muertos: s.eventosSync.muertos },
    kioskos: s.kioskos,
    pantallas: s.pantallas,
  };
}
