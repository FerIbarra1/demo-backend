import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { EstadoSurtido } from '@prisma/client';

export class MarcarSurtidoItemDto {
  @ApiProperty({
    description: 'Cantidad realmente surtida (0 si no hay stock)',
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
      'Motivo del bodeguero cuando hay faltante (se persiste en ItemPedido.motivoSurtido y se propaga al PedidoRevisionItem.motivo al confirmar).',
  })
  @IsOptional()
  @IsString()
  motivo?: string;

  @ApiPropertyOptional({
    description:
      'PrecioCO sustituto cuando el bodeguero eligió otra variante (otra talla/color u otro producto) en la quick option. Se persiste en ItemPedido.sustitucionPropuestaPrecioCOId. El backend valida que pertenezca a la misma tienda del pedido.',
  })
  @IsOptional()
  @IsInt()
  nuevoPrecioCOId?: number;
}
