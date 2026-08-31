/**
 * Núcleo compartido para "surtir juntos": encontrar pedidos con items
 * compartidos (mismo productoId o mismo precioCOId).
 *
 * Extraído de SurtidoService.calcularSimilaresParaPedido (F3, jul 2026) para
 * que también pueda usarlo BodegaService.obtenerSurtirJuntos (F10, ago 2026)
 * — el endpoint nuevo que alimenta el banner "Surtir juntos" en /bodega.
 *
 * F10: la función pura de scoring vive aquí para que surtido.service.ts
 * y bodega.service.ts la invoquen sin duplicar lógica. Esta función NO
 * toca Prisma — el caller pasa los datos ya cargados. Eso permite
 * testearla sin levantar la BD.
 */

import { zonaKey } from './zona.util';

export interface ItemParaSimilitud {
  productoId: number;
  colorId: number | null;
}

export interface PedidoParaSimilitud {
  id: number;
  numeroPedido: string;
  fechaPedido: Date;
  items: ItemParaSimilitud[];
}

export interface PedidoSimilarResultado {
  id: number;
  numeroPedido: string;
  score: number;
  itemsCompartidos: number;
  minutosEnCola: number;
}

/** Umbral mínimo de score para considerar un pedido "similar". */
const UMBRAL_SCORE_MINIMO = 10;
/** Top por pedido: el detalle de surtido muestra hasta 3 similares. */
const TOP_POR_PEDIDO = 3;
/** Top del listado general de la tienda. */
export const TOP_LISTA = 10;

/**
 * Peso por zona compartida. Una "zona" es la combinación producto+color:
 * en la bodega, todas las tallas de un mismo producto y color viven juntas,
 * así que un pedido que comparte una zona con otro puede surtirse en la
 * misma pasada sin volver a recorrer la bodega.
 */
const PESO_ZONA_COMPARTIDA = 10;

/**
 * Calcula la similitud entre un conjunto de "items de referencia" y N
 * pedidos candidatos. Devuelve los candidatos que comparten al menos una
 * zona (producto+color) con score >= UMBRAL_SCORE_MINIMO, ordenados por
 * score descendente y recortados al TOP indicado.
 *
 * El "score" suma PESO_ZONA_COMPARTIDA por cada zona DISTINTA compartida
 * (un candidato con dos tallas del mismo producto+color suma una sola vez),
 * más un bono de antigüedad en cola (1 punto por minuto desde fechaPedido)
 * para que los pedidos más viejos suban en el ranking.
 */
export function rankearSimilares(
  itemsReferencia: ItemParaSimilitud[],
  candidatos: PedidoParaSimilitud[],
  opts: { ahora?: Date; top?: number } = {},
): PedidoSimilarResultado[] {
  if (itemsReferencia.length === 0) return [];

  // Zonas de referencia: combinación productoId:colorId (colorId null → "sin color").
  const zonasRef = new Set(
    itemsReferencia.map((i) => zonaKey(i.productoId, i.colorId)),
  );

  const ahora = opts.ahora ?? new Date();
  const top = opts.top ?? TOP_POR_PEDIDO;

  return candidatos
    .map((c) => {
      // Zonas DISTINTAS del candidato que también están en las de referencia.
      const zonasCompartidas = new Set<string>();
      for (const it of c.items) {
        const key = zonaKey(it.productoId, it.colorId);
        if (zonasRef.has(key)) zonasCompartidas.add(key);
      }
      const score =
        zonasCompartidas.size * PESO_ZONA_COMPARTIDA +
        Math.floor((ahora.getTime() - c.fechaPedido.getTime()) / 60000);
      return {
        id: c.id,
        numeroPedido: c.numeroPedido,
        score,
        itemsCompartidos: zonasCompartidas.size,
        minutosEnCola: Math.floor(
          (ahora.getTime() - c.fechaPedido.getTime()) / 60000,
        ),
      };
    })
    .filter((r) => r.score >= UMBRAL_SCORE_MINIMO && r.itemsCompartidos > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
