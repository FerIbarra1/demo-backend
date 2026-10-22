import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const limpiar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `QUITAR_PRODUCTOS`: una línea del pedido y la cantidad con la que debe QUEDAR (0 = quitarla). Solo estos dos campos: ni
 * precio, ni subtotal, ni productos nuevos. Cualquier otra llave da 400 (`forbidNonWhitelisted`).
 */
export class LineaQuitarDto {
  @ApiProperty({ description: 'Id de la línea (`ItemPedido`) del pedido.' })
  @IsInt()
  @Min(1)
  itemId: number;

  @ApiProperty({
    description:
      'Cantidad con la que debe quedar la línea. 0 la quita. Nunca más de las que tiene hoy.',
    example: 0,
  })
  @IsInt()
  @Min(0)
  @Max(9999)
  cantidad: number;
}

/** Cuerpo de toda acción de destrabar. El motivo es obligatorio: es lo que queda en la bitácora. */
export class EjecutarAccionDto {
  @ApiProperty({
    example: 'El cliente avisó por teléfono que ya no lo quiere.',
    description: 'Para el personal. Nunca se le muestra al cliente.',
  })
  @Transform(limpiar)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo: string;

  @ApiPropertyOptional({
    description:
      'Mensaje que el cliente leerá en SU pedido (no se manda por correo). Se suma al texto estándar de la acción.',
  })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(300)
  mensajeCliente?: string;

  @ApiPropertyOptional({
    type: [LineaQuitarDto],
    description:
      'Solo `QUITAR_PRODUCTOS`: qué líneas quitar o bajar. Las demás acciones no lo usan.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LineaQuitarDto)
  items?: LineaQuitarDto[];
}

/** Cerrar una tarea del Sistema Comercial. Con `descartar` la nota es obligatoria. */
export class ResolverTareaDto {
  @ApiPropertyOptional({
    description: 'Obligatoria al descartar ("no aplica"): por qué no hay nada que hacer.',
  })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  nota?: string;
}
