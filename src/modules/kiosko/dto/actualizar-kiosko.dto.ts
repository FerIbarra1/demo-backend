import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EstadoKiosko } from '@prisma/client';

/**
 * PATCH /kiosko/:id. Solo se aplica lo que venga. El NOMBRE ("Kiosko 2") lo pone el sistema y la TIENDA no cambia:
 * ninguno de los dos se edita.
 */
export class ActualizarKioskoDto {
  @ApiPropertyOptional({
    example: 'Entrada',
    description: 'Dónde está la tablet. Vacío la borra.',
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ubicacion?: string;

  @ApiPropertyOptional({
    enum: EstadoKiosko,
    description: 'El interruptor: ACTIVO o INACTIVO',
  })
  @IsOptional()
  @IsIn([EstadoKiosko.ACTIVO, EstadoKiosko.INACTIVO])
  estado?: EstadoKiosko;
}
