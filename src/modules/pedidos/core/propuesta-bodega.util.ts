import { calcularAjuste, type ItemParaCalculo } from './calculadora-ajuste.util';
import type { ItemPropuestaJson } from '../propuesta/dto/propuesta.dto';

/**
 * F17 (oct 2026): construye la propuesta de bodega EN EL SERVIDOR.
 *
 * Antes la armaba el frontend (`demo-frontend/src/lib/propuesta.ts`,
 * `construirPropuestaDesdeItems`) y la mandaba como payload al endpoint. Con el
 * cierre de surtido en un solo botón (F17), el bodeguero ya no "envía una
 * propuesta": marca los items y el sistema decide. Así que la propuesta tiene
 * que nacer del propio `ItemPedido`, que ya trae todo lo necesario.
 *
 * Efecto lateral bueno: el cliente del API ya no puede mandar una propuesta
 * malformada (items que no pertenecen al pedido, estados inventados, subtotales
 * falsos) por el camino de bodega. El precio sale del snapshot del item, que es
 * lo que bodega verificó físicamente.
 *
 * Oct 2026 (Fase 2): ya no tiene lógica propia. Es `calcularAjuste` SIN
 * intenciones — el pedido tal como lo dejó el bodeguero—, la misma función que
 * arma la contrapropuesta del asesor. Antes cada camino tenía su copia del
 * cálculo (clasificación de líneas, precio con promo, total) y divergieron; los
 * specs de este util son ahora también los de la calculadora.
 *
 * Reglas (las implementa `calcularAjuste`):
 *   - COMPLETO con cantidadSurtida === cantidad → 'completo'
 *   - NO_DISPONIBLE                             → 'no-disponible'
 *   - PARCIAL (o COMPLETO con cantidad distinta) → 'parcial'
 *   - cancelada                                 → no se incluye
 *
 * El shape del JSON debe seguir coincidiendo con `PropuestaItem` del frontend
 * (`demo-frontend/src/lib/api/pedidos.ts`), que es quien lo renderiza.
 */

/** Campos mínimos del item que la propuesta necesita. */
export type ItemParaPropuesta = ItemParaCalculo;

/**
 * Devuelve los items de la propuesta y su total.
 *
 * `items` son los del pedido ANTES de liquidar el surtido (PARCIAL y
 * NO_DISPONIBLE todavía sin colapsar).
 */
export function construirPropuestaDeBodega(items: ItemParaPropuesta[]): {
  items: ItemPropuestaJson[];
  total: number;
} {
  const { items: propuestos, total } = calcularAjuste(items, []);
  return { items: propuestos, total };
}
