import { IsArray, IsNumber, IsString, IsOptional, IsEnum, ValidateNested, Min, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TipoPago } from '@prisma/client';

class ItemPedidoDto {
  @ApiProperty({ description: 'ID de PrecioCO (variante talla/color)' })
  @IsNumber()
  precioCOId: number;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  cantidad: number;
}

export class CreatePedidoDto {
  @ApiProperty({ type: [ItemPedidoDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemPedidoDto)
  @ArrayMinSize(1)
  items: ItemPedidoDto[];

  @ApiProperty({ enum: TipoPago, example: 'EFECTIVO' })
  @IsEnum(TipoPago)
  tipoPago: TipoPago;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;

  @ApiPropertyOptional({ description: 'Referencia de transferencia/deposito' })
  @IsOptional()
  @IsString()
  referenciaPago?: string;
}
