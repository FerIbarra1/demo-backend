import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Oct 2026: el asesor devuelve el pedido a bodega.
 *
 * La nota es opcional pero se recomienda: el bodeguero que recibe el pedido ve
 * el motivo en el historial, y "por qué me llegó esto" es justo lo que no podía
 * responderse cuando el pedido volvía desde asesoría.
 */
export class DevolverABodegaDto {
  @ApiPropertyOptional({
    description:
      'Por qué vuelve a bodega (ej. "el cliente ya no quiere cambios, surtan lo original").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  nota?: string;
}
