import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EstadoPedido } from '@prisma/client';

export class CambiarEstadoDto {
  @ApiProperty({ enum: EstadoPedido })
  @IsEnum(EstadoPedido)
  nuevoEstado: EstadoPedido;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observacion?: string;
}
