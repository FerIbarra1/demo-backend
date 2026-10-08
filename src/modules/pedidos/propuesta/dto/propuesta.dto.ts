import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * F12 (sep 2026): item de una propuesta de ajuste que bodega envía al cliente.
 * Mismo shape que el frontend `lib/propuesta.ts` (ItemPropuesta), para que el
 * snapshot sea directamente renderizable.
 */
export class PropuestaItemDto {
  @ApiProperty({ description: 'itemId real del pedido (>=1) o tempId negativo para agregados' })
  @IsInt()
  itemId: number;

  @ApiProperty({
    enum: ['completo', 'cambio', 'no-disponible', 'parcial', 'agregado'],
  })
  @IsString()
  tipo: string;

  @ApiProperty()
  @IsString()
  producto: string;

  @ApiProperty()
  @IsString()
  variante: string;

  @ApiPropertyOptional({ description: 'Imagen del producto (del color pedido).' })
  @IsOptional()
  @IsString()
  productoImagen?: string | null;

  @ApiProperty()
  @IsInt()
  @Min(0)
  cantidad: number;

  @ApiProperty()
  @IsNumber()
  precioUnitario: number;

  @ApiProperty()
  @IsNumber()
  subtotal: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productoOriginal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  varianteOriginal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cantidadOriginal?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productoNuevo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  varianteNueva?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cantidadNueva?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  precioUnitarioNuevo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  subtotalNuevo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  tempId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  productoId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  precioCOId?: number;
}

export class CrearPropuestaDto {
  @ApiProperty({ type: [PropuestaItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PropuestaItemDto)
  items: PropuestaItemDto[];

  @ApiProperty({
    description:
      'Total propuesto. El backend lo RECALCULA desde los items y lo ignora: ' +
      'ahora que el asesor de ventas propone precios, confiar en este valor ' +
      'permitiría aprobar un número distinto al que se cobra.',
  })
  @IsNumber()
  @Min(0)
  total: number;

  @ApiPropertyOptional({ description: 'Nota libre del autor que acompaña la propuesta' })
  @IsOptional()
  @IsString()
  nota?: string;
}

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
  productoOriginal?: string;
  varianteOriginal?: string;
  cantidadOriginal?: number;
  productoNuevo?: string;
  varianteNueva?: string;
  cantidadNueva?: number;
  precioUnitarioNuevo?: number;
  subtotalNuevo?: number;
  tempId?: number;
  productoId?: number;
  precioCOId?: number;
}
