import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class BuscarPedidoDto {
  @ApiPropertyOptional({
    description: 'Número exacto del pedido (ej: PD-2026-000123) o fragmento del nombre del cliente',
    example: 'PD-2026-000123',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;
}
