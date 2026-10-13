import { Prisma, EstadoSurtido } from '@prisma/client';
import { precioConPromoVolumen } from '../../precios/precio-lista.util';
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
  /**
   * F19 (oct 2026): la imagen del producto, ya resuelta por el caller.
   *
   * Faltaba, y era el bug visible: la propuesta de BODEGA salía sin fotos
   * mientras la de VENTAS sí las traía (el frontend se las metía al armar su
   * borrador). La tarjeta caía al placeholder de iniciales.
   *
   * El caller la resuelve con `StorageService.resolverImagen` — el mismo helper
   * que usan `obtenerDetalle` y `PedidoStateService` — porque este util es
   * dominio puro y no puede tocar la BD ni el storage.
   */
  productoImagen?: string | null;
  /**
   * F19: el id del producto, para que la tarjeta pueda resolver la foto contra
   * el catálogo si el snapshot no la trae. Mismo camino que un `agregado` de
   * ventas.
   */
  productoId?: number | null;
  corridaNombre: string;
  tallaNombre: string;
  colorNombre: string;
  /** F19: la cantidad PEDIDA (inmutable). Ver `ItemPedido.cantidadPedida`. */
  cantidadPedida: number;
  cantidad: number;
  cantidadSurtida: number;
  estadoSurtido: EstadoSurtido;
  precioUnitario: Prisma.Decimal | number;
  precioUnitarioBase: Prisma.Decimal | number | null;
  precioUnitarioMayoreo: Prisma.Decimal | number | null;
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

  /**
   * F19 (oct 2026): el precio de cada pieza DESPUÉS de aplicar esta propuesta.
   *
   * El bug que arregla: `subtotalNuevo` se calculaba como
   * `precioUnitario * cantidadNueva`, usando el precio VIEJO — que puede traer
   * aplicada la promo de volumen (12+ piezas → lista 2). Pero al aprobar, el
   * pedido se recalcula con `recalcularTotalesPedido` → `aplicarPromoVolumen`,
   * que REVOCA la promo si el pedido bajó de 12 piezas.
   *
   * Con un pedido de menudeo de 12 piezas que baja a 10: la propuesta decía
   * 10 × $80 = $800 y el cobro era 10 × $100 = $1000. El cliente aprobaba un
   * número y se le cobraba otro, $200 de diferencia.
   *
   * La corrección NO es "aplicar la promo a mano" ni un gate por lista de
   * precios: es llamar a la MISMA función que usa el cobro
   * (`precioConPromoVolumen`), con el total de piezas FINAL del pedido. Así los
   * dos números no pueden divergir, y el `min(base, mayoreo)` interno respeta
   * solo los tipos de cuenta que de verdad califican — un cliente de lista 3..6
   * ya tiene base más barata que lista 2, así que el mínimo es su propia lista y
   * la promo nunca le encarece nada.
   *
   * El conteo final simula el estado del pedido tras aplicar la propuesta:
   * cada item cancelado cuenta 0 y cada parcial cuenta su cantidad nueva.
   */
  const totalPiezasFinal = items.reduce((acc, it) => {
    if (it.cancelada) return acc;
    if (it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) return acc;
    if (
      it.estadoSurtido === EstadoSurtido.PARCIAL ||
      (it.estadoSurtido === EstadoSurtido.COMPLETO && it.cantidadSurtida !== it.cantidad)
    ) {
      return acc + Math.max(0, it.cantidadSurtida);
    }
    return acc + it.cantidad;
  }, 0);

  /**
   * F19 (oct 2026): ¿este item sigue en el pedido después de aplicar la propuesta?
   *
   * Un `NO_DISPONIBLE` se cancela (`aplicarCambiosFisicos`), así que NO se cobra.
   * Antes su `subtotal` — el de la cantidad PEDIDA, que es la que trae el item —
   * se sumaba al total de la propuesta: en un pedido de $1000 con un producto
   * agotado de $300, la propuesta decía **$1300** y se cobraban $1000. El cliente
   * veía un total inflado justo en la pantalla donde decide si acepta.
   *
   * Es el mismo tratamiento que le da `recalcularTotalesPedido`, que sólo suma
   * items con `cancelada: false`.
   */
  const sigueEnElPedido = (it: ItemParaPropuesta) =>
    !it.cancelada && it.estadoSurtido !== EstadoSurtido.NO_DISPONIBLE;

  /**
   * Precio efectivo de una pieza con la promo re-evaluada al tamaño FINAL del
   * pedido. Si el item no trae el par congelado (pedido anterior a la promo de
   * sep 2026) se usa su precio actual: `aplicarPromoVolumen` tampoco lo tocaría.
   */
  const precioEfectivo = (it: ItemParaPropuesta): number => {
    const base = it.precioUnitarioBase;
    const mayoreo = it.precioUnitarioMayoreo;
    if (base == null) return Number(it.precioUnitario);
    return Number(
      precioConPromoVolumen(
        new Prisma.Decimal(base),
        new Prisma.Decimal(mayoreo ?? base),
        totalPiezasFinal,
      ),
    );
  };

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
        productoImagen: it.productoImagen ?? null,
        productoId: it.productoId ?? undefined,
        variante,
        cantidad: it.cantidadPedida,
        precioUnitario,
        // F19: se cancela, así que no se cobra. El subtotal del item es el de la
        // cantidad PEDIDA (la que trae), y sumarlo inflaba el total propuesto.
        subtotal: 0,
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
      const precioNuevo = precioEfectivo(it);
      propuestos.push({
        itemId: it.id,
        tipo: 'parcial',
        producto: it.productoNombre,
        productoCodigo: it.productoCodigo,
        productoImagen: it.productoImagen ?? null,
        productoId: it.productoId ?? undefined,
        variante,
        cantidad: it.cantidadPedida,
        precioUnitario,
        subtotal,
        productoOriginal: it.productoNombre,
        varianteOriginal: variante,
        cantidadOriginal: it.cantidadPedida,
        productoNuevo: it.productoNombre,
        varianteNueva: variante,
        cantidadNueva,
        precioUnitarioNuevo: precioNuevo,
        subtotalNuevo: precioNuevo * cantidadNueva,
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
      productoImagen: it.productoImagen ?? null,
      productoId: it.productoId ?? undefined,
      variante,
      cantidad: it.cantidadPedida,
      precioUnitario,
      subtotal,
    });
  }

  // F19: el total es la suma de lo que SOBREVIVE a la propuesta. Un
  // `no-disponible` se cancela y no se cobra, así que no suma — igual que en
  // `recalcularTotalesPedido`, que sólo cuenta items con `cancelada: false`.
  const total = propuestos.reduce((acc, i) => {
    if (i.tipo === 'no-disponible') return acc;
    if (i.tipo === 'cambio' || i.tipo === 'parcial' || i.tipo === 'agregado') {
      return acc + (i.subtotalNuevo ?? i.subtotal);
    }
    return acc + i.subtotal;
  }, 0);

  return { items: propuestos, total };
}
