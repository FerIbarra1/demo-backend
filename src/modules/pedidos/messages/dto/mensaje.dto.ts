import { IsString, IsOptional, IsBoolean, IsInt, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CrearMensajeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  contenido: string;

  @ApiPropertyOptional({ description: 'Sólo BODEGA/CAJERO/ADMIN pueden setear false' })
  @IsOptional()
  @IsBoolean()
  visibleParaCliente?: boolean;

  @ApiPropertyOptional({
    description:
      'ID del ItemPedido al que se ancla este mensaje (ej: propuesta sobre una variante específica). Debe pertenecer al mismo pedido. Si se omite, es un mensaje general del pedido.',
  })
  @IsOptional()
  @IsInt()
  itemId?: number;
}
