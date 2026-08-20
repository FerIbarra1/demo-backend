import { IsOptional, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { EstadoKiosko } from '@prisma/client';

export class ListarKioskosQueryDto {
  @ApiPropertyOptional({ description: 'Filtrar por tienda' })
  @IsOptional()
  @Type(() => Number)
  tiendaId?: number;

  @ApiPropertyOptional({ enum: EstadoKiosko })
  @IsOptional()
  @IsIn(['ACTIVO', 'INACTIVO'])
  estado?: EstadoKiosko;
}
