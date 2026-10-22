import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class FolioAckItemDto {
  @ApiProperty({ example: 1234 })
  @IsInt()
  @Min(1)
  pedidoId: number;

  @ApiProperty({ example: 'agent-central-01' })
  @IsString()
  @MaxLength(100)
  agentId: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  exito: boolean;

  @ApiProperty({
    example: '0000152574',
    required: false,
    description:
      'El consecutivo que el agente reservó en CONSECUTIVOS (10 dígitos). Obligatorio si exito.',
  })
  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'folio debe tener exactamente 10 dígitos' })
  folio?: string;

  @ApiProperty({ example: 'CONSECUTIVOS: lock timeout', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}

export class FoliosAckDto {
  @ApiProperty({ example: 1, description: 'IDTIENDA de Firebird (== Tienda.externalId)' })
  @IsInt()
  @Min(1)
  tiendaId: number;

  @ApiProperty({ type: [FolioAckItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FolioAckItemDto)
  acks: FolioAckItemDto[];
}
