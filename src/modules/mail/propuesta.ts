/**
 * Parser ligero de los mensajes tipo @@PROPUESTA@@ que envía el bodeguero.
 *
 * No usamos `lib/propuesta.ts` del frontend directamente (no es compartida)
 * — definimos el shape mínimo aquí para que el backend pueda renderizar la
 * propuesta como tabla HTML en el email al cliente.
 *
 * Forma esperada del JSON entre delimitadores:
 *   {
 *     "v": 1,
 *     "items": [
 *       {
 *         "itemId": 16,
 *         "tipo": "parcial" | "completo" | "no-disponible" | "cambio" | "agregado",
 *         "producto": "...",
 *         "variante": "...",
 *         "cantidad": 1,
 *         "precioUnitario": 299.99,
 *         "subtotal": 299.99,
 *         "productoOriginal"?: "...",
 *         "varianteOriginal"?: "...",
 *         "cantidadOriginal"?: 1,
 *         "productoNuevo"?: "...",
 *         "varianteNueva"?: "...",
 *         "cantidadNueva"?: 3,
 *         "precioUnitarioNuevo"?: 299.99,
 *         "subtotalNuevo"?: 899.97
 *       }
 *     ],
 *     "total": 899.97
 *   }
 */

export const PROPUESTA_PREFIX = '@@PROPUESTA@@';
export const PROPUESTA_SUFFIX = '@@/PROPUESTA@@';

export type TipoItemPropuesta =
  | 'completo'
  | 'cambio'
  | 'no-disponible'
  | 'parcial'
  | 'agregado';

export interface ItemPropuestaJson {
  itemId: number;
  tipo: TipoItemPropuesta;
  producto: string;
  variante: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  productoOriginal?: string;
  varianteOriginal?: string;
  cantidadOriginal?: number;
  productoNuevo?: string;
  varianteNueva?: string;
  cantidadNueva?: number;
  precioUnitarioNuevo?: number;
  subtotalNuevo?: number;
}

export interface PropuestaJson {
  v: number;
  items: ItemPropuestaJson[];
  total: number;
}

export interface PropuestaParseada {
  propuesta: PropuestaJson;
  /** Texto libre fuera del bloque @@PROPUESTA@@ (puede ir antes/después). */
  textoLibre: string;
}

/**
 * Extrae el JSON de la propuesta del contenido del mensaje. Si el parseo
 * falla (versión desconocida, JSON malformado), devuelve `null` para que
 * el caller renderice el contenido crudo como fallback.
 */
export function parsePropuestaContenido(contenido: string): PropuestaParseada | null {
  const startIdx = contenido.indexOf(PROPUESTA_PREFIX);
  const endIdx = contenido.indexOf(PROPUESTA_SUFFIX, startIdx);
  if (startIdx < 0 || endIdx < 0) return null;

  const jsonStart = startIdx + PROPUESTA_PREFIX.length;
  const jsonStr = contenido.slice(jsonStart, endIdx).trim();
  let propuesta: PropuestaJson;
  try {
    propuesta = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!propuesta || propuesta.v !== 1 || !Array.isArray(propuesta.items)) {
    return null;
  }

  const textoLibre =
    (contenido.slice(0, startIdx) + ' ' + contenido.slice(endIdx + PROPUESTA_SUFFIX.length))
      .trim()
      .replace(/\s+/g, ' ');

  return { propuesta, textoLibre };
}

/**
 * Texto resumen que también muestra el frontend al final del bloque JSON
 * crudo (lo usa la BodegaMiPedidoCard como fallback). Lo replicamos para
 * mantener consistencia entre emails y la UI.
 */
export function resumenPropuesta(p: PropuestaJson): string {
  const counts: Record<string, number> = {};
  for (const it of p.items) {
    counts[it.tipo] = (counts[it.tipo] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const tipo of ['completo', 'parcial', 'cambio', 'no-disponible', 'agregado'] as const) {
    if (counts[tipo]) {
      const n = counts[tipo];
      const label = {
        completo: n === 1 ? '1 completo' : `${n} completos`,
        parcial: n === 1 ? '1 parcial' : `${n} parciales`,
        cambio: n === 1 ? '1 cambio' : `${n} cambios`,
        'no-disponible': n === 1 ? '1 no disponible' : `${n} no disponibles`,
        agregado: n === 1 ? '1 agregado' : `${n} agregados`,
      }[tipo];
      parts.push(label);
    }
  }
  const total = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(p.total);
  return `Resumen: ${parts.join(', ')}. Total: ${total}`;
}
