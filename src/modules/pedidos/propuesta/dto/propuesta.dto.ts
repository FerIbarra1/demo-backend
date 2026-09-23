import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
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
export type DecisionPropuesta =
  | 'APROBAR'
  | 'RECHAZAR'
  | 'CONTACTAR_ASESOR'
  | 'CANCELAR_PEDIDO';

export class ResponderPropuestaDto {
  @ApiProperty({ enum: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'] })
  @IsIn(['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'])
  decision: DecisionPropuesta;

  @ApiPropertyOptional({
    description:
      'Nota libre del cliente (motivo del rechazo, qué quiere negociar con el asesor).',
  })
  @IsOptional()
  @IsString()
  nota?: string;
}
