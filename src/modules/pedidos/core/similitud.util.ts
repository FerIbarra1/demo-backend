import { PrismaClient } from '@prisma/client';

/**
 * Núcleo compartido para "surtir juntos": encontrar pedidos con items
 * compartidos (mismo productoId o mismo precioCOId).
 *
 * Extraído de SurtidoService.calcularSimilaresParaPedido (F3, jul 2026) para
 * que también pueda usarlo BodegaService.obtenerSurtirJuntos (F10, ago 2026)
 * — el endpoint nuevo que alimenta el banner "Surtir juntos" en /bodega.
 *
 * F10: las funciones puras de scoring viven aquí para que surtido.service.ts
 * y bodega.service.ts las invoquen sin duplicar lógica. Las funciones que
 * hacen I/O (Prisma) se inyectan como dependencia para mantener este módulo
 * testeable sin base de datos.
 */

export interface ItemParaSimilitud {
  productoId: number;
  precioCOId: number | null;
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

/** Mismos pesos que el monitor (jul 2026). */
export const UMBRAL_SCORE_MINIMO = 4;
export const TOP_POR_PEDIDO = 3;
export const TOP_LISTA = 10;
export const PESO_PRECIO_CO_COMPARTIDO = 10;
export const PESO_PRODUCTO_COMPARTIDO = 4;

/**
 * Calcula la similitud entre un conjunto de "items de referencia" y N
 * pedidos candidatos. Devuelve los candidatos que comparten al menos un
 * item (por productoId o precioCOId) con score >= UMBRAL_SCORE_MINIMO,
 * ordenados por score descendente y recortados al TOP indicado.
 *
 * Función pura — no toca Prisma. El caller pasa los datos ya cargados.
 *
 * El "score" incluye un bono por antigüedad en cola (1 punto por minuto
 * desde fechaPedido) para que los pedidos más viejos suban en el ranking.
 */
export function rankearSimilares(
  itemsReferencia: ItemParaSimilitud[],
  candidatos: PedidoParaSimilitud[],
  opts: { ahora?: Date; top?: number } = {},
): PedidoSimilarResultado[] {
  if (itemsReferencia.length === 0) return [];

  const productoIdsRef = new Set(itemsReferencia.map((i) => i.productoId));
  const precioCOIdsRef = new Set(
    itemsReferencia.map((i) => i.precioCOId).filter((v): v is number => v != null),
  );

  const ahora = opts.ahora ?? new Date();
  const top = opts.top ?? TOP_POR_PEDIDO;

  return candidatos
    .map((c) => {
      let score = 0;
      let itemsCompartidos = 0;
      for (const it of c.items) {
        if (it.precioCOId && precioCOIdsRef.has(it.precioCOId)) {
          score += PESO_PRECIO_CO_COMPARTIDO;
          itemsCompartidos++;
        } else if (productoIdsRef.has(it.productoId)) {
          score += PESO_PRODUCTO_COMPARTIDO;
          itemsCompartidos++;
        }
      }
      const minutosEnCola = Math.floor(
        (ahora.getTime() - c.fechaPedido.getTime()) / 60000,
      );
      score += minutosEnCola; // bono antigüedad
      return {
        id: c.id,
        numeroPedido: c.numeroPedido,
        score,
        itemsCompartidos,
        minutosEnCola,
      };
    })
    .filter((r) => r.score >= UMBRAL_SCORE_MINIMO && r.itemsCompartidos > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/**
 * Helper para acceder a Prisma desde los services que importen este módulo.
 * Tipado contra PrismaClient para que sea explícito sin importar PrismaService
 * desde aquí (mantiene este archivo 100% puro, testeable sin DI de Nest).
 */
export type PrismaLike = Pick<PrismaClient, 'itemPedido' | 'pedido'>;
