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

// =================================================================
// F12 (sep 2026): agrupación de la COLA por zona compartida.
// =================================================================

export interface PedidoColaParaAgrupar {
  id: number;
  numeroPedido: string;
  clienteNombre: string;
  canalOrigen: string;
  fechaPedido: Date;
  items: ItemParaSimilitud[];
}

export interface ClusterSurtirJuntos {
  /** Id estable del cluster (derivado de los ids de sus pedidos, ordenados). */
  grupoId: string;
  /** Pedidos del cluster, ordenados por antigüedad (más viejos primero). */
  pedidos: PedidoColaParaAgrupar[];
  /** Zonas (producto+color) compartidas por al menos 2 pedidos del cluster. */
  zonasCompartidas: string[];
}

/**
 * Agrupa los pedidos de la cola en clusters donde cada par de pedidos del
 * mismo cluster comparte al menos una zona (producto+color). Es un problema
 * de componentes conexos: dos pedidos están conectados si comparten zona.
 *
 * F12: a diferencia de `rankearSimilares` (que parte de los pedidos del
 * bodeguero), esto agrupa la COLA completa sin depender de lo que el
 * bodeguero ya tenga tomado. Así el bodeguero ve sugerencias desde el
 * momento en que entran pedidos, sin seleccionar uno primero.
 *
 * Devuelve solo clusters con >= 2 pedidos (un cluster de 1 no es "surtir
 * juntos"). Cada cluster se ordena por antigüedad.
 */
export function agruparColaPorZonaCompartida(
  pedidos: PedidoColaParaAgrupar[],
): ClusterSurtirJuntos[] {
  if (pedidos.length < 2) return [];

  // Mapa zona → set de pedidos que la tienen.
  const pedidosPorZona = new Map<string, Set<number>>();
  for (const p of pedidos) {
    const zonas = new Set(p.items.map((i) => zonaKey(i.productoId, i.colorId)));
    for (const z of zonas) {
      let s = pedidosPorZona.get(z);
      if (!s) {
        s = new Set();
        pedidosPorZona.set(z, s);
      }
      s.add(p.id);
    }
  }

  // Union-find para componentes conexos.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Compresión de ruta.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const p of pedidos) parent.set(p.id, p.id);
  for (const zonaPedidos of pedidosPorZona.values()) {
    const arr = Array.from(zonaPedidos);
    for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  }

  // Agrupar por raíz.
  const porRaiz = new Map<number, PedidoColaParaAgrupar[]>();
  for (const p of pedidos) {
    const r = find(p.id);
    let arr = porRaiz.get(r);
    if (!arr) {
      arr = [];
      porRaiz.set(r, arr);
    }
    arr.push(p);
  }

  const clusters: ClusterSurtirJuntos[] = [];
  for (const arr of porRaiz.values()) {
    if (arr.length < 2) continue;
    // Zonas compartidas por al menos 2 pedidos del cluster.
    const zonasCompartidas = Array.from(pedidosPorZona.entries())
      .filter(([, ids]) => {
        const enCluster = Array.from(ids).filter((id) =>
          arr.some((p) => p.id === id),
        );
        return enCluster.length >= 2;
      })
      .map(([z]) => z);
    const ordenados = [...arr].sort(
      (a, b) => a.fechaPedido.getTime() - b.fechaPedido.getTime(),
    );
    const grupoId = ordenados
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join('-');
    clusters.push({
      grupoId,
      pedidos: ordenados,
      zonasCompartidas,
    });
  }

  // Ordenar clusters por el pedido más viejo (los más urgentes primero).
  clusters.sort(
    (a, b) =>
      a.pedidos[0].fechaPedido.getTime() - b.pedidos[0].fechaPedido.getTime(),
  );

  return clusters;
}
