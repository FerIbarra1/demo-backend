import {
  IsArray,
  IsNumber,
  ValidateNested,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class ItemPromoInputDto {
  @ApiProperty({ description: 'ID de PrecioCO (variante talla/color)' })
  @IsNumber()
  precioCOId: number;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  cantidad: number;
}

/**
 * Carrito del cliente para evaluar la promo de volumen.
 *
 * Misma forma que `ItemPedidoInputDto` de la creación de pedidos: el frontend
 * manda exactamente lo que tiene en el carrito, sin transformarlo.
 */
export class PromoVolumenDto {
  @ApiProperty({ type: [ItemPromoInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemPromoInputDto)
  @ArrayMinSize(1)
  items: ItemPromoInputDto[];
}
