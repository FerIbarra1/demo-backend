/**
 * Clave de "zona" de bodega: combinación productoId + colorId. En la bodega,
 * todas las tallas de un mismo producto y color viven juntas, así que un
 * pedido que comparte una zona con otro puede surtirse en la misma pasada.
 *
 * Si el item no tiene colorId, se usa colorNombre como fallback para no
 * perder el agrupamiento (caso de items sin variante de color).
 */
export function zonaKey(
  productoId: number,
  colorId: number | null,
  colorNombre?: string | null,
): string {
  if (colorId != null) return `${productoId}:${colorId}`;
  return `${productoId}:${colorNombre ?? 'sin-color'}`;
}
