import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class PedidoAckItemDto {
  @ApiProperty({ example: 1234 })
  @IsInt()
  @Min(0)
  pedidoId: number;

  @ApiProperty({ example: 'agent-central-01' })
  @IsString()
  @MaxLength(100)
  agentId: string;

  @ApiProperty({ example: 'lease-token' })
  @IsString()
  @MaxLength(80)
  leaseToken: string;

  @ApiProperty({ example: 987, required: false, description: 'IDPEDIDO devuelto por GRABAR_PEDIDOS' })
  @IsOptional()
  @IsInt()
  @Min(0)
  externalIdPEDIDOS?: number;

  @ApiProperty({ example: '0000012345', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  externalFolio?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  exito: boolean;

  @ApiProperty({ example: 'GRABAR_PEDIDOS: timeout', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}

export class PedidosAckDto {
  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(1)
  tiendaId: number;

  @ApiProperty({ type: [PedidoAckItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PedidoAckItemDto)
  acks: PedidoAckItemDto[];
}
