import { IsString, IsOptional, IsBoolean, IsInt, IsNumber, MaxLength, IsArray, ValidateNested, ArrayMinSize, IsIn, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * F15 (sep 2026): marca de agua de lectura del chat (modelo WhatsApp/Telegram).
 * El cliente llama este endpoint cuando abre el detalle del pedido con foco,
 * y el lado tienda lo llama cuando un VENTAS/ADMIN/CAJERO abre el detalle.
 *
 * El backend deriva el LADO del caller desde el JWT (no del body) y avanza
 * el watermark de forma idempotente y monotona (nunca decrementa).
 *
 * `entregado: true` se usa cuando el cliente recibe el eco del socket y bumpea
 * el watermark `cliente_ultimo_mensaje_entregado_id` sin pasar por REST.
 */
export class MarcarLeidoDto {
  @ApiProperty({ description: 'ID del último mensaje que el caller ya vió.' })
  @IsInt()
  @Min(1)
  ultimoMensajeId: number;

  @ApiPropertyOptional({
    description:
      'Sólo usado por el cliente: confirma que recibió el eco del socket ' +
      '(entregado). Si se manda junto con leído, el backend garantiza que ' +
      'entregado >= leído (un leído implica entregado).',
  })
  @IsOptional()
  @IsBoolean()
  entregado?: boolean;
}

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

/**
 * F13 (sep 2026): un item dentro de la propuesta adjunta al mensaje.
 * Mismo shape que `PropuestaItemDto` en propuesta.dto.ts pero revalidado acá
 * para que el chat-controller no dependa del controller de propuestas.
 */
export class PropuestaAdjuntaItemDto {
  @ApiProperty()
  @IsInt()
  itemId: number;

  @ApiProperty({ enum: ['completo', 'parcial', 'no-disponible', 'cambio', 'agregado'] })
  @IsIn(['completo', 'parcial', 'no-disponible', 'cambio', 'agregado'])
  tipo: 'completo' | 'parcial' | 'no-disponible' | 'cambio' | 'agregado';

  @ApiProperty()
  @IsString()
  producto: string;

  @ApiProperty()
  @IsString()
  variante: string;

  @ApiProperty()
  @IsInt()
  cantidad: number;

  @ApiProperty()
  @IsNumber()
  precioUnitario: number;

  @ApiProperty()
  @IsNumber()
  subtotal: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cantidadNueva?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  subtotalNuevo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  precioCOId?: number;
}

/**
 * F13 (sep 2026): endpoint unificado para mandar un mensaje que opcionalmente
 * adjunta una propuesta. Si `propuestaItems` viene, se crea la propuesta en la
 * misma transacción y el mensaje lleva su id en `adjunto`.
 */
export class CrearMensajeConAdjuntoDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  contenido: string;

  @ApiPropertyOptional({ type: [PropuestaAdjuntaItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PropuestaAdjuntaItemDto)
  propuestaItems?: PropuestaAdjuntaItemDto[];

  @ApiPropertyOptional({ description: 'Total propuesto; obligatorio si viene propuestaItems' })
  @IsOptional()
  total?: number;
}
