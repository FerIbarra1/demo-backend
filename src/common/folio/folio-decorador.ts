import { formatearFolio } from '../../modules/pedidos/core/folio-erp.util';

/**
 * Oct 2026 (parte B2) — el servidor decide cómo se llama un pedido en pantalla.
 *
 * Todo objeto que parezca un pedido (trae `numeroPedido`, `tiendaId` y `folioErp`) sale de la API con un campo más:
 * `folio`, la etiqueta lista para mostrar (`HMO-0000152573`), o `null` mientras el agente no le asigna su folio del Sistema
 * Comercial. La pantalla no arma la etiqueta ni conoce la serie de cada tienda: lee `folio` y, si es null, muestra lo que
 * ya mostraba (el número interno). Hay ~40 sitios del backend que devuelven un pedido; en vez de repetir esta regla en
 * cada uno, vive aquí y la aplica un interceptor global (`FolioPedidoInterceptor`) a toda respuesta HTTP.
 *
 * Un objeto con un `select` que NO pidió `folioErp` o `tiendaId` no se decora (no hay de dónde sacar el folio): quien
 * devuelva un pedido a una pantalla que muestre el ID debe incluirlos. Las TV públicas tampoco lo reciben a propósito:
 * no traen esas llaves y reciben solo su `turno` (los últimos dígitos).
 */

/** Tope de nodos recorridos por respuesta: una lista enorme (catálogo) no debe costar más de unos milisegundos. */
const MAX_NODOS = 60_000;
const MAX_PROFUNDIDAD = 12;

const esObjetoPlano = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

export function esPedidoLike(o: Record<string, unknown>): boolean {
  return typeof o.numeroPedido === 'string' && typeof o.tiendaId === 'number' && 'folioErp' in o;
}

/**
 * Agrega `folio` a todo pedido que haya en `valor` (a cualquier profundidad). Muta en place: la respuesta es del
 * request. No toca fechas, decimales, buffers ni nada que no sea objeto plano o arreglo.
 */
export function decorarConFolio(
  valor: unknown,
  serieDe: (tiendaId: number) => string | null | undefined,
): void {
  let nodos = 0;
  const vistos = new WeakSet<object>();

  const visitar = (v: unknown, profundidad: number): void => {
    if (nodos++ > MAX_NODOS || profundidad > MAX_PROFUNDIDAD) return;
    if (Array.isArray(v)) {
      if (vistos.has(v)) return;
      vistos.add(v);
      for (const x of v) visitar(x, profundidad + 1);
      return;
    }
    if (!esObjetoPlano(v) || vistos.has(v)) return;
    vistos.add(v);

    if (esPedidoLike(v) && !('folio' in v)) {
      const folioErp = v.folioErp;
      v.folio =
        typeof folioErp === 'string' && folioErp
          ? formatearFolio(serieDe(v.tiendaId as number), folioErp)
          : null;
    }
    for (const k of Object.keys(v)) visitar(v[k], profundidad + 1);
  };

  visitar(valor, 0);
}
