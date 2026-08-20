import { IsString, IsOptional, IsIn, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EstadoKiosko } from '@prisma/client';

/**
 * DTO para actualizar un kiosko existente (PATCH /kiosko/:id).
 * Todos los campos son opcionales; sólo se aplican los que vengan.
 * El admin puede renombrar y/o activar/desactivar.
 */
export class ActualizarKioskoDto {
  @ApiPropertyOptional({
    example: 'Kiosko Entrada 1',
    description: 'Nuevo nombre del kiosko (único por tienda)',
    minLength: 2,
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  nombre?: string;

  @ApiPropertyOptional({
    enum: EstadoKiosko,
    description: 'Cambiar estado: ACTIVO o INACTIVO',
  })
  @IsOptional()
  @IsIn([EstadoKiosko.ACTIVO, EstadoKiosko.INACTIVO])
  estado?: EstadoKiosko;
}
