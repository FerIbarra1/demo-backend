import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * F13 (sep 2026): decisiones del cliente. Cuáles son legales depende del
 * ORIGEN de la propuesta (ver `PropuestaService.DECISIONES_POR_ORIGEN`):
 *
 *   Propuesta de BODEGA: APROBAR | RECHAZAR | CONTACTAR_ASESOR
 *   Propuesta de VENTAS: APROBAR | RECHAZAR | CANCELAR_PEDIDO
 *
 * El backend valida, no confía en el frontend.
 */
export type DecisionPropuesta = 'APROBAR' | 'RECHAZAR' | 'CONTACTAR_ASESOR' | 'CANCELAR_PEDIDO';

export class ResponderPropuestaDto {
  @ApiProperty({ enum: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'] })
  @IsIn(['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'])
  decision: DecisionPropuesta;

  /**
   * Oct 2026: el texto del cliente.
   *
   * OBLIGATORIO cuando pide ajustes (`CONTACTAR_ASESOR`). No es una nota
   * interna: es el PRIMER mensaje del chat con el asesor y el único contexto
   * que él recibe para saber qué ajustar. Sin él, el asesor abre la
   * conversación con un "quiero ajustes" y nada más, y tiene que preguntar
   * todo por chat — que es justo lo que este cambio evita.
   *
   * Opcional en el resto de las decisiones, donde sigue siendo el motivo libre
   * que alimenta `PedidoPropuesta.notaCliente` (el motivo del rechazo, la
   * cancelación con su lista de reposición).
   */
  @ApiPropertyOptional({
    description:
      'Texto del cliente. Obligatorio al pedir ajustes (CONTACTAR_ASESOR): ' +
      'es el primer mensaje del chat con el asesor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @ValidateIf((o) => o.decision === 'CONTACTAR_ASESOR')
  @IsNotEmpty({
    message: 'Cuéntanos qué cambios quieres en tu pedido para que el asesor pueda hacer el ajuste.',
  })
  nota?: string;
}

/**
 * Un item de la propuesta tal como se guarda en `PedidoPropuesta.items` (JSON).
 *
 * Es la forma SERIALIZADA del snapshot: la propuesta guarda el item completo
 * para que la tarjeta del chat pueda mostrar la foto, el productoId (para
 * resolver la imagen de un `agregado`) y el "antes" de los tipos `cambio` y
 * `parcial`, sin volver a consultar el pedido.
 *
 * Vivía declarada al final de `propuesta.service.ts`; se movió aquí porque es
 * un tipo de transporte, no de servicio.
 */
export interface ItemPropuestaJson {
  itemId: number;
  tipo: 'completo' | 'cambio' | 'no-disponible' | 'parcial' | 'agregado';
  producto: string;
  /**
   * Oct 2026: el código del producto (ej. "C0200").
   *
   * Faltaba, y es el dato que el personal usa para identificar la prenda: en
   * tienda la etiqueta física trae el código y el cliente compara contra lo que
   * ve en pantalla. Sin él la tarjeta de la propuesta mostraba nombre, talla y
   * color — todo lo que NO está impreso en la prenda.
   *
   * Se guarda en el snapshot (y no se resuelve en el frontend) para que cubra
   * también los productos que el asesor AGREGA, que no existen en
   * `pedido.items` y por tanto no tendrían de dónde sacarlo.
   */
  productoCodigo?: string | null;
  variante: string;
  productoImagen?: string | null;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  /**
   * Oct 2026: lo que esta línea VALÍA antes de esta propuesta (cantidad × precio
   * congelado del item, tal como estaba en el pedido).
   *
   * Lo sella el SERVIDOR (`calcularAjuste`), nunca el navegador. Desde la Fase 2
   * el cliente de la API ni siquiera manda líneas: manda su intención
   * (`IntencionAjusteDto`) y el servidor arma todo el snapshot.
   *
   * Existe porque la tarjeta no podía decir "antes de estos cambios" con el
   * `subtotal` de la propia línea: una línea sin existencia viaja con
   * `subtotal: 0` (no se cobra) y una completa con el precio YA re-evaluado, así
   * que la suma daba $548.75 donde el pedido valía $707.75 y la tarjeta le
   * mostraba al cliente una baja de $178.75 cuando la real era de $337.75.
   *
   * Ausente en propuestas anteriores a este cambio y en las líneas `agregado`
   * (no existían en el pedido). La tarjeta no inventa un total "antes" si falta.
   */
  subtotalOriginal?: number;
  productoOriginal?: string;
  varianteOriginal?: string;
  cantidadOriginal?: number;
  /** true solo si ventas/mostrador editó explícitamente esta línea. */
  ajusteExplicito?: boolean;
  /**
   * F21 (oct 2026): lo que HAY en el anaquel, cuando difiere de lo que el cliente
   * se lleva.
   *
   * Es el número del medio en "Pediste 5 · Hay 3 · Te llevas 1". Sin él, la
   * tarjeta de la propuesta solo puede pintar dos de los tres hechos — y el que
   * se cae es justo "había 3", que es lo que le dice al cliente que no le están
   * dando de menos.
   *
   * Se omite cuando coincide con `cantidadNueva`: no hay nada que aclarar.
   */
  cantidadDisponible?: number;
  productoNuevo?: string;
  varianteNueva?: string;
  cantidadNueva?: number;
  precioUnitarioNuevo?: number;
  subtotalNuevo?: number;
  tempId?: number;
  productoId?: number;
  precioCOId?: number;
  /**
   * Fase 2 (oct 2026): cuántas piezas de esta línea tiene que surtir bodega
   * (las que exceden lo que ya está en la bolsa). Ausente cuando es 0.
   *
   * Lo estampa la calculadora (`calcularAjuste`): la tarjeta del cliente solo suma
   * este campo para decir "Bodega surtirá N piezas más", sin reimplementar la
   * regla de qué hay en la bolsa.
   */
  piezasPorSurtir?: number;
  /**
   * Fase 2: el precio de mayoreo de esta propuesta depende de piezas que bodega
   * aún no ha visto (si no las encuentra, el pedido baja de 12 y el precio se
   * recalcula). Se estampa en TODAS las líneas cuando aplica, porque el snapshot
   * es un arreglo y no tiene dónde llevar un dato de la propuesta entera.
   */
  mayoreoCondicional?: boolean;
}
