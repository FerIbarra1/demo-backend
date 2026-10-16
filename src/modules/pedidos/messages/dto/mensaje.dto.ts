import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  MaxLength,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  Min,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntencionAjusteDto } from '../../propuesta/dto/ajuste.dto';

/**
 * F15 (sep 2026): marca de agua de lectura del chat (modelo WhatsApp/Telegram).
 * El cliente llama este endpoint cuando abre el detalle del pedido con foco,
 * y el lado tienda lo llama cuando un VENTAS/ADMIN/CAJERO abre el detalle.
 *
 * El backend deriva el LADO del caller desde el JWT (no del body) y avanza
 * el watermark de forma idempotente y monotona (nunca decrementa).
 *
 * Oct 2026: se quitó el flag `entregado`. Existía para el estado 'entregado'
 * (✓✓ gris) del frontend, que se eliminó porque se alimentaba del watermark del
 * lado equivocado y no distinguía ninguna decisión en un chat 1:1. La columna
 * `cliente_ultimo_mensaje_entregado_id` sigue en BD (dato histórico) y el
 * service la mantiene al día: un leído siempre implica entregado.
 */
export class MarcarLeidoDto {
  @ApiProperty({ description: 'ID del último mensaje que el caller ya vió.' })
  @IsInt()
  @Min(1)
  ultimoMensajeId: number;
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
 * F13 (sep 2026): endpoint unificado para mandar un mensaje que opcionalmente
 * adjunta una propuesta. Si `ajuste` viene, se crea la propuesta en la misma
 * transacción y el mensaje lleva su id en `adjunto`.
 *
 * Oct 2026 (Fase 2): la propuesta ya NO viaja como líneas armadas por el
 * navegador (`propuestaItems`, con nombres, precios y subtotales). Viaja la
 * INTENCIÓN del asesor (`ajuste`: "esta línea a 3", "quita esta", "agrega esta
 * variante") y el servidor calcula todo lo demás con `calcularAjuste`. Por eso
 * este DTO ya no tiene `total` ni precios: el `ValidationPipe` global corre con
 * `forbidNonWhitelisted`, así que un cliente que los mande recibe 400.
 */
export class CrearMensajeConAdjuntoDto {
  // Oct 2026: el texto es OBLIGATORIO cuando NO se adjunta propuesta, pero
  // OPCIONAL cuando sí — el asesor puede mandar la propuesta sola con un texto
  // por defecto en backend. Esto evita que el chat muestre una burbuja vacía
  // cuando el operador presiona "Enviar" sin escribir nada.
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  @ValidateIf((o) => !o.ajuste || o.ajuste.length === 0)
  @IsNotEmpty({
    message: 'El texto del mensaje es obligatorio cuando no se adjunta una propuesta.',
  })
  contenido: string;

  @ApiPropertyOptional({ type: [IntencionAjusteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => IntencionAjusteDto)
  ajuste?: IntencionAjusteDto[];
}
