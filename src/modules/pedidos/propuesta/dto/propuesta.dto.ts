import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
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

  @ApiProperty()
  @IsNumber()
  @Min(0)
  total: number;

  @ApiPropertyOptional({ description: 'Nota libre del bodeguero que acompaña la propuesta' })
  @IsOptional()
  @IsString()
  nota?: string;
}

export class ResponderPropuestaDto {
  @ApiProperty({ enum: ['ACEPTAR', 'RECHAZAR'] })
  @IsString()
  decision: 'ACEPTAR' | 'RECHAZAR';

  @ApiPropertyOptional({ description: 'Nota libre del cliente (ej. motivo del rechazo)' })
  @IsOptional()
  @IsString()
  nota?: string;
}
