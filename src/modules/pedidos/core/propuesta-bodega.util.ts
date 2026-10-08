import { Prisma, EstadoSurtido } from '@prisma/client';
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
 * Reglas (espejo EXACTO del helper del frontend, para que el cliente vea la
 * misma propuesta que veía antes):
 *   - COMPLETO con cantidadSurtida === cantidad → 'completo'
 *   - NO_DISPONIBLE                             → 'no-disponible'
 *   - PARCIAL (o COMPLETO con cantidad distinta) → 'parcial'
 *   - PENDIENTE o cancelada                     → no se incluye
 *
 * El shape del JSON debe seguir coincidiendo con `PropuestaItem` del frontend
 * (`demo-frontend/src/lib/api/pedidos.ts`), que es quien lo renderiza.
 */

/** Campos mínimos del item que la propuesta necesita. */
export interface ItemParaPropuesta {
  id: number;
  productoNombre: string;
  /** Oct 2026: viaja al snapshot para que la tarjeta muestre el código. */
  productoCodigo: string;
  corridaNombre: string;
  tallaNombre: string;
  colorNombre: string;
  cantidad: number;
  cantidadSurtida: number;
  estadoSurtido: EstadoSurtido;
  precioUnitario: Prisma.Decimal | number;
  subtotal: Prisma.Decimal | number;
  cancelada: boolean;
}

/** Une corrida · talla · color, igual que el helper del frontend. */
function varianteDe(item: Pick<ItemParaPropuesta, 'corridaNombre' | 'tallaNombre' | 'colorNombre'>): string {
  return [item.corridaNombre, item.tallaNombre, item.colorNombre].filter(Boolean).join(' · ');
}

/**
 * Devuelve los items de la propuesta y su total.
 *
 * `total` se calcula aquí (no se confía a nadie): es la suma de los subtotales
 * efectivos, donde "efectivo" es el nuevo si el item cambió de cantidad.
 */
export function construirPropuestaDeBodega(items: ItemParaPropuesta[]): {
  items: ItemPropuestaJson[];
  total: number;
} {
  const propuestos: ItemPropuestaJson[] = [];

  for (const it of items) {
    if (it.cancelada) continue;

    const variante = varianteDe(it);
    const precioUnitario = Number(it.precioUnitario);
    const subtotal = Number(it.subtotal);

    if (it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) {
      propuestos.push({
        itemId: it.id,
        tipo: 'no-disponible',
        producto: it.productoNombre,
        productoCodigo: it.productoCodigo,
        variante,
        cantidad: it.cantidad,
        precioUnitario,
        subtotal,
      });
      continue;
    }

    // PARCIAL, o COMPLETO con una cantidad distinta a la pedida (bodega surtió
    // más o menos). El cliente aprueba la cantidad REAL, no la pedida.
    if (
      it.estadoSurtido === EstadoSurtido.PARCIAL ||
      (it.estadoSurtido === EstadoSurtido.COMPLETO && it.cantidadSurtida !== it.cantidad)
    ) {
      const cantidadNueva = Math.max(0, it.cantidadSurtida);
      propuestos.push({
        itemId: it.id,
        tipo: 'parcial',
        producto: it.productoNombre,
        productoCodigo: it.productoCodigo,
        variante,
        cantidad: it.cantidad,
        precioUnitario,
        subtotal,
        productoOriginal: it.productoNombre,
        varianteOriginal: variante,
        cantidadOriginal: it.cantidad,
        productoNuevo: it.productoNombre,
        varianteNueva: variante,
        cantidadNueva,
        precioUnitarioNuevo: precioUnitario,
        subtotalNuevo: precioUnitario * cantidadNueva,
      });
      continue;
    }

    // COMPLETO tal cual. Se incluye para que el cliente vea el pedido entero
    // (los items que sí llegaron), no solo los faltantes.
    propuestos.push({
      itemId: it.id,
      tipo: 'completo',
      producto: it.productoNombre,
      productoCodigo: it.productoCodigo,
      variante,
      cantidad: it.cantidad,
      precioUnitario,
      subtotal,
    });
  }

  const total = propuestos.reduce((acc, i) => {
    if (i.tipo === 'cambio' || i.tipo === 'parcial' || i.tipo === 'agregado') {
      return acc + (i.subtotalNuevo ?? i.subtotal);
    }
    return acc + i.subtotal;
  }, 0);

  return { items: propuestos, total };
}
