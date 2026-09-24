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
