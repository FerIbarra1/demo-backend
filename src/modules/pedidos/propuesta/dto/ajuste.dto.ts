import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Oct 2026 (Fase 2): lo que el asesor o el operador QUIEREN hacer con el pedido.
 *
 * Es la ÚNICA entrada del ajuste. Antes el editor mandaba la propuesta ya
 * armada —nombre, variante, imagen, precio, subtotal, "antes" y "después" de cada
 * línea— y el servidor la guardaba tal cual; ahora manda solo la intención y el
 * servidor calcula todo lo demás (`calcularAjuste`). Ver ese util para el porqué.
 *
 *   { accion: 'CANTIDAD', itemId, cantidad }     esta línea queda en N piezas
 *   { accion: 'QUITAR',   itemId }               esta línea sale del pedido
 *   { accion: 'AGREGAR',  precioCOId, cantidad } agrega N piezas de una variante
 *   { accion: 'REPONER',  itemId, cantidad }     una línea que bodega no encontró
 *                                                vuelve con N piezas (oct 2026)
 *
 * `ValidateIf` por acción: cada campo solo es obligatorio donde tiene sentido.
 * El `ValidationPipe` global corre con `forbidNonWhitelisted`, así que cualquier
 * campo que no esté declarado aquí (precio, subtotal, nombre…) hace que el
 * request entero falle con 400. Es a propósito: el cliente de la API ya no puede
 * influir en un precio.
 */
export class IntencionAjusteDto {
  @ApiProperty({ enum: ['CANTIDAD', 'QUITAR', 'AGREGAR', 'REPONER'] })
  @IsIn(['CANTIDAD', 'QUITAR', 'AGREGAR', 'REPONER'])
  accion: 'CANTIDAD' | 'QUITAR' | 'AGREGAR' | 'REPONER';

  @ApiPropertyOptional({ description: 'CANTIDAD, QUITAR y REPONER: el item del pedido.' })
  @ValidateIf((o: IntencionAjusteDto) => o.accion !== 'AGREGAR')
  @IsInt()
  itemId?: number;

  @ApiPropertyOptional({ description: 'AGREGAR: la variante del catálogo.' })
  @ValidateIf((o: IntencionAjusteDto) => o.accion === 'AGREGAR')
  @IsInt()
  precioCOId?: number;

  @ApiPropertyOptional({
    description: 'CANTIDAD, AGREGAR y REPONER: piezas finales de la línea (≥ 1).',
  })
  @ValidateIf((o: IntencionAjusteDto) => o.accion !== 'QUITAR')
  @IsInt()
  @Min(1)
  @Max(9999)
  cantidad?: number;
}

/** Cuerpo de `POST /pedidos/:id/ajuste/vista-previa`. */
export class VistaPreviaAjusteDto {
  @ApiProperty({ type: [IntencionAjusteDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => IntencionAjusteDto)
  intenciones: IntencionAjusteDto[];
}
