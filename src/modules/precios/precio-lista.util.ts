import { Prisma } from '@prisma/client';

/**
 * Fase 0 (sep 2026): resolución de la lista de precios del cliente.
 *
 * Antes esta lógica vivía privada en `CatalogoService`, así que el catálogo
 * respetaba la lista del cliente pero el PEDIDO se creaba con `pco.precio`
 * (que es sinónimo de `lista1` según el schema de `PrecioCO`). Resultado: un
 * cliente con lista 3 veía precios de lista 3 en pantalla y se le cobraba
 * lista 1, con el error congelado en `ItemPedido.precioUnitario` (snapshot)
 * viajando así al ERP.
 *
 * Estas funciones son puras a propósito: la resolución de la lista y la
 * elección del precio son las dos reglas que NO pueden divergir entre el
 * catálogo y la creación/ajuste de pedidos. El acceso a BD vive en
 * `PreciosService`.
 */

/** Columna de `PrecioCO` que corresponde a la lista de precios del cliente. */
export type ColumnaLista =
  | 'lista1'
  | 'lista2'
  | 'lista3'
  | 'lista4'
  | 'lista5'
  | 'lista6';

/**
 * Shape mínimo de un `PrecioCO` para resolver su precio. Acepta cualquier
 * representación numérica porque Prisma devuelve `Decimal` en las lecturas
 * pero los tests y algunos callers pasan `number`/`string`.
 */
export interface PrecioConListas {
  precio: Prisma.Decimal | number | string;
  lista1: Prisma.Decimal | number | string;
  lista2: Prisma.Decimal | number | string;
  lista3: Prisma.Decimal | number | string;
  lista4: Prisma.Decimal | number | string;
  lista5: Prisma.Decimal | number | string;
  lista6: Prisma.Decimal | number | string;
}

/**
 * Traduce el código de lista de Firebird (`CLIENTES.LISPRE`, '1'..'6') a la
 * columna de `PrecioCO`. Cualquier valor desconocido, vacío o ausente cae a
 * `lista1`, que es el comportamiento histórico.
 */
export function columnaDesdeCodigo(
  codigo: string | null | undefined,
): ColumnaLista {
  switch ((codigo ?? '').trim()) {
    case '2':
      return 'lista2';
    case '3':
      return 'lista3';
    case '4':
      return 'lista4';
    case '5':
      return 'lista5';
    case '6':
      return 'lista6';
    default:
      return 'lista1';
  }
}

/**
 * Resuelve la columna de lista con la precedencia correcta:
 *
 *   1. La lista POR TIENDA (`UsuarioTienda.listaPrecioCodigo`) — un cliente
 *      puede tener una lista distinta en cada sucursal.
 *   2. Fallback a la lista GLOBAL del usuario (`Usuario.listaPrecioCodigo`).
 *   3. Fallback final a `lista1`.
 *
 * El primer nivel usa `??` (no `||`): un código por-tienda de cadena vacía es
 * un valor presente y se respeta, igual que antes del refactor.
 */
export function resolverColumnaLista(
  codigoPorTienda: string | null | undefined,
  codigoGlobal: string | null | undefined,
): ColumnaLista {
  return columnaDesdeCodigo(codigoPorTienda ?? codigoGlobal);
}

/**
 * Precio de un `PrecioCO` en la lista indicada, con fallback a `pco.precio`.
 *
 * El fallback existe porque Firebird puede tener listas sin capturar (0) para
 * una variante; en ese caso se usa el precio base en vez de cobrar cero.
 * Devuelve `Decimal` para no introducir error de punto flotante en los
 * subtotales del pedido.
 */
export function precioDeLista(
  pco: PrecioConListas,
  columna: ColumnaLista,
): Prisma.Decimal {
  const deLista = new Prisma.Decimal(pco[columna] ?? 0);
  return deLista.greaterThan(0) ? deLista : new Prisma.Decimal(pco.precio);
}

/**
 * Promo de volumen (sep 2026): a partir de 12 piezas —mezclando productos,
 * colores y tallas libremente— se aplica el precio de lista 2.
 *
 * El umbral y la lista destino van fijos en código a propósito: son una regla
 * comercial, no configuración de sitio. Si cambian, cambian con un deploy y
 * los pedidos ya creados conservan el par de precios que congelaron.
 */
export const PIEZAS_MAYOREO = 12;
export const COLUMNA_MAYOREO: ColumnaLista = 'lista2';

/**
 * Precio efectivo de UNA pieza según la promo de volumen.
 *
 * Es LA regla, en un solo lugar, y por eso la llaman los tres caminos que
 * necesitan saber el precio: la creación del pedido (`ClienteService`), la
 * re-evaluación (`aplicarPromoVolumen`) y el endpoint del carrito
 * (`CatalogoService.evaluarPromoVolumen`). Mientras los tres llamen aquí, no
 * pueden divergir.
 *
 * Bajo el umbral devuelve el precio base. Al alcanzarlo devuelve
 * `min(base, mayoreo)`, que es lo que implementa "solo para el cliente de
 * menudeo": un cliente de lista 3..6 ya tiene un precio base MÁS BARATO que
 * lista2 (las listas van de menudeo caro a mayoreo barato), así que el mínimo
 * es su propia lista y la promo nunca le encarece nada.
 *
 * Expresarlo como MÍNIMO y no como "¿es lista1?" es deliberado y tiene dos
 * consecuencias, ambas deseadas:
 *
 *   1. Es una función pura del par de precios CONGELADO, así que se puede
 *      re-evaluar dentro de una transacción sin consultar la lista del cliente
 *      (que requeriría salir del `tx`). Un gate por columna no se puede: la
 *      columna no vive en el item.
 *   2. Es consistente cuando Firebird tiene una lista sin capturar (0). Ahí
 *      `precioDeLista` ya cae al precio base, así que el precio EFECTIVO de ese
 *      cliente es el de lista1 aunque su columna diga lista3 — y la promo
 *      sigue ese precio efectivo, no el nombre de la columna. Un gate por
 *      columna diría "no califica" al crear y "sí califica" al re-evaluar, y el
 *      pedido cambiaría de precio solo, sin que nadie lo edite.
 *
 * Nunca sube un precio: `min` es idempotente y monótono, así que aplicarla dos
 * veces da el mismo resultado.
 */
export function precioConPromoVolumen(
  precioBase: Prisma.Decimal,
  precioMayoreo: Prisma.Decimal,
  totalPiezas: number,
): Prisma.Decimal {
  if (totalPiezas < PIEZAS_MAYOREO) return precioBase;
  return Prisma.Decimal.min(precioBase, precioMayoreo);
}
