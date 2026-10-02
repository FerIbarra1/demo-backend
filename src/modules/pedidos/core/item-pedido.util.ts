import { Prisma } from '@prisma/client';
import {
  precioDeLista,
  precioConPromoVolumen,
  COLUMNA_MAYOREO,
  type ColumnaLista,
  type PrecioConListas,
} from '../../precios/precio-lista.util';

/**
 * Construye los datos de un `ItemPedido` nuevo a partir de una variante del
 * catálogo (`PrecioCO`), con el snapshot de precios completo.
 *
 * Este bloque estaba copiado en TRES lugares —`ClienteService.crearPedido`,
 * `MostradorService.aplicarAjuste` (rama `agregado`) y
 * `PropuestaService.aplicarPropuestaDeVentas` (ramas `agregado`/`cambio`)—
 * con los mismos 14 campos y las mismas dos llamadas a `precioDeLista`. Las
 * únicas diferencias reales eran tres, y son los parámetros: si el precio
 * efectivo aplica ya la promo de volumen, y los flags `original` /
 * `estadoSurtido`.
 *
 * Los 14 campos son un SNAPSHOT a propósito: si mañana cambia el precio del
 * catálogo o el nombre del producto, el pedido debe seguir mostrando lo que se
 * cotizó. Por eso no se leen en el render.
 */

/**
 * Variante del catálogo con las relaciones que el snapshot necesita.
 * Extiende `PrecioConListas` porque las 7 columnas de precio son la entrada de
 * `precioDeLista`.
 */
export interface VarianteParaItem extends PrecioConListas {
  id: number;
  productoId: number;
  producto: { nombre: string; codigo: string };
  corrida: { nombre: string };
  talla: { nombre: string };
  color: { nombre: string };
}

export interface OpcionesItemPedido {
  /** Columna de lista del cliente que hizo el pedido. */
  columnaLista: ColumnaLista;
  /**
   * Total de piezas del pedido DESPUÉS de aplicar este cambio.
   *
   * - Al CREAR el pedido (`crearPedido`) se conoce de antemano, así que se
   *   pasa y el precio efectivo ya sale con la promo aplicada.
   * - Al AGREGAR un item a un pedido existente (mostrador, propuesta) el total
   *   final todavía no se sabe, así que se omite: se congela el par
   *   (base, mayoreo) con el efectivo en la base, y
   *   `recalcularTotalesPedido` —que corre al final del flujo— lo ajusta si el
   *   pedido llega a 12 piezas.
   */
  totalPiezas?: number;
  /**
   * `true` si el producto venía en el pedido original del cliente; `false` si
   * lo agregó un operador. Es la señal que bodega usa para saber que el pedido
   * volvió con cambios.
   */
  original: boolean;
  /**
   * `true` para un item creado al dar de alta el pedido (nadie lo ha surtido
   * todavía y bodega lo tomará). Si se omite, el item nace `PENDIENTE` con
   * `cantidadSurtida: 0` — el caso de un producto agregado después, que
   * obliga a bodega a verificar que exista en el anaquel.
   */
  esNuevoDelPedido?: boolean;
}

/**
 * Devuelve el `data` de un `itemPedido.create`, con el snapshot de precios y
 * de nombres ya resuelto.
 *
 * NO valida que la variante sea de la tienda del pedido: eso lo hace cada
 * caller, porque el mensaje de error cambia según el contexto (el cliente lee
 * "no está disponible en esta tienda", el operador "pertenece a otra tienda").
 */
export function construirItemPedido(
  pco: VarianteParaItem,
  cantidad: number,
  opts: OpcionesItemPedido,
): Omit<Prisma.ItemPedidoUncheckedCreateInput, 'pedidoId'> {
  const precioUnitarioBase = precioDeLista(pco, opts.columnaLista);
  const precioUnitarioMayoreo = precioDeLista(pco, COLUMNA_MAYOREO);

  // Con el total de piezas conocido, el efectivo ya trae la promo; si no, se
  // congela el par y `recalcularTotalesPedido` decide al final.
  const precioUnitario =
    opts.totalPiezas != null
      ? precioConPromoVolumen(precioUnitarioBase, precioUnitarioMayoreo, opts.totalPiezas)
      : precioUnitarioBase;

  const esNuevo = opts.esNuevoDelPedido ?? false;

  return {
    productoId: pco.productoId,
    precioCOId: pco.id,
    cantidad,
    // Snapshot de la cantidad original. El handler de MOVPED compara contra
    // este valor para distinguir surtido COMPLETO de PARCIAL cuando el
    // bodeguero ajusta cantidades en VFP.
    cantidadOriginal: cantidad,
    precioUnitario,
    precioUnitarioBase,
    precioUnitarioMayoreo,
    subtotal: precioUnitario.mul(cantidad),
    productoNombre: pco.producto.nombre,
    productoCodigo: pco.producto.codigo,
    corridaNombre: pco.corrida.nombre,
    tallaNombre: pco.talla.nombre,
    colorNombre: pco.color.nombre,
    original: opts.original,
    cancelada: false,
    // Un item recién creado al dar de alta el pedido no trae estado de
    // surtido: bodega lo tomará. Uno agregado después nace PENDIENTE para
    // forzar la verificación física.
    ...(esNuevo ? {} : { estadoSurtido: 'PENDIENTE' as const, cantidadSurtida: 0 }),
  };
}
