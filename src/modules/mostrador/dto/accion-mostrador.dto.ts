import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * F16 (sep 2026): acciones del operador de mostrador sobre un pedido en
 * `EN_MOSTRADOR`.
 *
 * El motivo/nota se guardan en `HistorialPedido.observacion`, así que tienen un
 * tope de longitud: son para que quede constancia de POR QUÉ se canceló o
 * ajustó, no para conversaciones largas (esas van por el chat del pedido).
 */

/**
 * Un cambio sobre un item del pedido, tal como lo manda el editor.
 *
 * IMPORTANTE: no lleva `precioUnitario`. El precio SIEMPRE lo resuelve el
 * servidor desde `PrecioCO` con la lista del cliente que hizo el pedido — si se
 * aceptara del cliente del API, un operador podría mandar `precioUnitario: 0`
 * y regalar mercancía. Mismo principio que el total de las propuestas, que
 * también se recalcula server-side.
 */
export class ItemAjusteDto {
  @ApiPropertyOptional({
    description:
      'ID del item existente. Obligatorio para parcial/no-disponible; ' +
      'ausente para agregado.',
  })
  @IsOptional()
  @IsInt()
  itemId?: number;

  @ApiProperty({
    enum: ['completo', 'parcial', 'no-disponible', 'agregado'],
    description:
      'completo = sin cambio · parcial = nueva cantidad · ' +
      'no-disponible = quitar · agregado = producto nuevo',
  })
  @IsIn(['completo', 'parcial', 'no-disponible', 'agregado'])
  tipo!: 'completo' | 'parcial' | 'no-disponible' | 'agregado';

  @ApiPropertyOptional({ description: 'Nueva cantidad (para tipo=parcial).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  cantidad?: number;

  @ApiPropertyOptional({
    description: 'Variante del catálogo (para tipo=agregado). El precio lo resuelve el servidor.',
  })
  @IsOptional()
  @IsInt()
  precioCOId?: number;

  @ApiPropertyOptional({ description: 'Producto del catálogo (para tipo=agregado).' })
  @IsOptional()
  @IsInt()
  productoId?: number;
}

export class AjustarPedidoDto {
  @ApiProperty({
    description:
      'Qué pidió cambiar el cliente. Queda en el historial del pedido.',
    example: 'Quiere 2 playeras más en talla M',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  nota!: string;

  @ApiPropertyOptional({
    type: [ItemAjusteDto],
    description:
      'Cambios sobre los items. Si no se manda, el ajuste solo registra la ' +
      'nota y manda el pedido a bodega sin tocar items (compatibilidad con ' +
      'la Fase 1).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemAjusteDto)
  items?: ItemAjusteDto[];
}

export class CancelarPedidoDto {
  @ApiProperty({
    description: 'Motivo de la cancelación. Queda en el historial del pedido.',
    example: 'El cliente se arrepintió al ver los productos',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;
}

export class LiberarPedidoDto {
  @ApiPropertyOptional({
    description:
      'Nota opcional. Se usa cuando el operador libera SIN aviso de llegada ' +
      'del cliente (decisión D2: puede hacerlo, pero queda registrado).',
    example: 'Cliente presente en tienda, no avisó por el kiosko',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  nota?: string;
}
