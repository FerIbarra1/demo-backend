import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class BuscarPedidoDto {
  @ApiPropertyOptional({
    description:
      'Texto libre: folio interno (PD-2026-000123), folio de VFP (el que trae el ' +
      'ticket del cliente), nombre del cliente o correo.',
    example: 'PD-2026-000123',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Página (1-based). El buscador pagina desde oct 2026.',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @ApiPropertyOptional({
    description: 'Resultados por página.',
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limite?: number;

  /**
   * Solo ADMIN: la tienda donde buscar. Va declarado aquí porque el `ValidationPipe` global tiene
   * `forbidNonWhitelisted`: sin la propiedad, `?tiendaId=` daba 400 a TODOS los roles. El valor se lee
   * crudo en `@TiendaConsola()` (que ignora este campo para un empleado); aquí solo se deja pasar.
   */
  @ApiPropertyOptional({
    description:
      'Solo ADMIN: tienda donde buscar (obligatoria para él). Se ignora para el resto de roles.',
  })
  @IsOptional()
  tiendaId?: string;
}
