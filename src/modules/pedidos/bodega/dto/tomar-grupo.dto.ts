import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

/**
 * F11 (ago 2026): body de POST /bodega/pedidos/tomar-grupo.
 * Toma varios pedidos similares ("surtir juntos") de una sola vez.
 */
export class TomarGrupoDto {
  @ApiProperty({
    description: 'IDs de los pedidos similares a tomar en grupo.',
    type: [Number],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids: number[];
}
