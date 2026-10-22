import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Lo que el agente leyó de `PEDIDOS` en Firebird para UN pedido. */
export class ConciliacionItemDto {
  @ApiProperty({ example: 1000000123, description: 'IDPEDIDO en Firebird' })
  @IsInt()
  @Min(1)
  externalIdPEDIDOS: number;

  @ApiProperty({ description: 'false = el Sistema Comercial ya no tiene esa fila' })
  @IsBoolean()
  existe: boolean;

  @ApiProperty()
  @IsBoolean()
  swcancel: boolean;

  @ApiProperty()
  @IsBoolean()
  finalizada: boolean;

  @ApiProperty({ required: false, nullable: true, description: 'TTOTAL en pesos' })
  @IsOptional()
  @IsNumber()
  total?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  idfactura?: number | null;
}

export class ConciliacionDto {
  @ApiProperty({ example: 2, description: 'IDTIENDA de Firebird (= Tienda.externalId)' })
  @IsInt()
  @Min(0)
  tiendaId: number;

  @ApiProperty({ type: [ConciliacionItemDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ConciliacionItemDto)
  pedidos: ConciliacionItemDto[];
}
