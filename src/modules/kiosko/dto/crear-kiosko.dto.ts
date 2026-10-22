import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * POST /kiosko — alta de un kiosko. El nombre ("Kiosko 1", "Kiosko 2"…) lo pone el sistema.
 * El ADMIN elige la tienda; para el GERENTE la tienda es la suya y, si manda otra, es 403.
 */
export class CrearKioskoDto {
  @ApiPropertyOptional({
    description: 'Tienda del kiosko. Obligatoria para el ADMIN; el gerente usa la suya.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;

  @ApiPropertyOptional({
    example: 'Entrada',
    description: 'Dónde estará la tablet (opcional).',
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ubicacion?: string;
}
