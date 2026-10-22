import { EstadoDtf } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ESTADOS_DTF_PENDIENTES, ESTADOS_DTF_QUE_SE_COBRAN } from './core/dtf-estado.util';

/**
 * El DTF de un pedido, tal como lo necesitan MOSTRADOR y CAJA (PLAN-DTF.md §9 y §14.1).
 *
 * El DTF NO es un `ItemPedido`: las listas de prendas de esas consolas no lo traen, pero el total del pedido
 * SÍ lo suma. Sin este resumen caja veía un total que no cuadraba con las líneas que tenía enfrente, y mostrador
 * no sabía que un pedido "mixto" seguía esperando su impresión. Lo calcula el servidor (la pantalla no deduce
 * nada del estado de cada trabajo) y viaja con cada fila como `dtfResumen`.
 */
export interface LineaDtfResumen {
  id: number;
  nombre: string;
  tecnologia: 'TEXTIL' | 'UV';
  tipoNombre: string;
  estado: EstadoDtf;
  copias: number;
  /** Metros que se cobran (null mientras el archivo no se mide). */
  metros: number | null;
  precioMetro: number;
  subtotal: number;
  /** Cuenta para el total del pedido (los rechazados no). */
  cobra: boolean;
}

export interface ResumenDtfPedido {
  lineas: LineaDtfResumen[];
  /** Lo que suman al total del pedido las líneas que se cobran. */
  total: number;
  /** Cuántos trabajos se cobran / cuántos ya están impresos / cuántos faltan por imprimir. */
  cobrados: number;
  listos: number;
  pendientes: number;
  /**
   * Caso B del ERP (PLAN-DTF.md §9): el Sistema Comercial todavía no recibe la línea de DTF, así que caja la
   * captura a mano. Un texto por línea que se cobra, listo para leerse tal cual ("DTF Textil · LOGO — 0.50 m × $220.00").
   */
  capturaCaja: string[];
}

const dinero = (n: number) =>
  `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Un viaje a la BD para TODAS las filas de una lista (no una consulta por pedido). */
export async function resumenDtfPorPedido(
  prisma: Pick<PrismaService, 'pedidoDtf'>,
  pedidoIds: number[],
): Promise<Map<number, ResumenDtfPedido>> {
  const out = new Map<number, ResumenDtfPedido>();
  if (pedidoIds.length === 0) return out;
  const filas = await prisma.pedidoDtf.findMany({
    where: {
      pedidoId: { in: pedidoIds },
      estado: { notIn: ['BORRADOR', 'EXPIRADO', 'CANCELADO'] },
    },
    select: {
      id: true,
      pedidoId: true,
      nombre: true,
      estado: true,
      copias: true,
      metrosCobrados: true,
      precioMetro: true,
      subtotal: true,
      tipo: { select: { tecnologia: true, nombre: true } },
    },
    orderBy: { id: 'asc' },
  });
  for (const f of filas) {
    if (f.pedidoId == null) continue;
    const r = out.get(f.pedidoId) ?? {
      lineas: [],
      total: 0,
      cobrados: 0,
      listos: 0,
      pendientes: 0,
      capturaCaja: [],
    };
    const cobra = ESTADOS_DTF_QUE_SE_COBRAN.includes(f.estado);
    const metros = f.metrosCobrados == null ? null : Number(f.metrosCobrados);
    const subtotal = Number(f.subtotal);
    r.lineas.push({
      id: f.id,
      nombre: f.nombre,
      tecnologia: f.tipo.tecnologia as 'TEXTIL' | 'UV',
      tipoNombre: f.tipo.nombre,
      estado: f.estado,
      copias: f.copias,
      metros,
      precioMetro: Number(f.precioMetro),
      subtotal,
      cobra,
    });
    if (cobra) {
      r.total = Number((r.total + subtotal).toFixed(2));
      r.cobrados += 1;
      r.capturaCaja.push(
        `${f.tipo.nombre} · ${f.nombre} — ${metros != null ? metros.toFixed(2) : 'por medir'} m × ${dinero(Number(f.precioMetro))} = ${dinero(subtotal)}`,
      );
    }
    if (f.estado === EstadoDtf.IMPRESO) r.listos += 1;
    if (ESTADOS_DTF_PENDIENTES.includes(f.estado)) r.pendientes += 1;
    out.set(f.pedidoId, r);
  }
  return out;
}

/** Agrega `dtfResumen` (o null si el pedido no tiene DTF) a cada fila de una lista. */
export async function conResumenDtf<T extends { id: number }>(
  prisma: Pick<PrismaService, 'pedidoDtf'>,
  pedidos: T[],
): Promise<(T & { dtfResumen: ResumenDtfPedido | null })[]> {
  const porPedido = await resumenDtfPorPedido(
    prisma,
    pedidos.map((p) => p.id),
  );
  return pedidos.map((p) => ({ ...p, dtfResumen: porPedido.get(p.id) ?? null }));
}
