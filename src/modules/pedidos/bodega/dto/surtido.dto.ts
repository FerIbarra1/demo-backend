import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { EstadoSurtido } from '@prisma/client';

/**
 * F13 (sep 2026): el bodeguero SOLO reporta existencia. Se eliminó
 * `nuevoPrecioCOId` (la sustitución de producto/color/talla): proponer
 * variantes o productos distintos es tarea del asesor de ventas, que arma
 * una contrapropuesta completa al cliente.
 */
export class MarcarSurtidoItemDto {
  @ApiProperty({
    description: 'Cantidad realmente surtida (0 si no hay)',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  cantidadSurtida: number;

  @ApiProperty({
    enum: EstadoSurtido,
    description:
      'PENDIENTE: aún no se ha surtido. PARCIAL: se surtió menos de lo pedido. COMPLETO: se surtió todo. NO_DISPONIBLE: no se pudo surtir nada.',
  })
  @IsEnum(EstadoSurtido)
  estadoSurtido: EstadoSurtido;

  @ApiPropertyOptional({
    description:
      'Motivo del bodeguero cuando hay faltante (se persiste en ItemPedido.motivoSurtido).',
  })
  @IsOptional()
  @IsString()
  motivo?: string;
}
