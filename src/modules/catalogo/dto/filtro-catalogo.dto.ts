import { IsOptional, IsNumber, IsString, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class FiltroCatalogoDto {
  @ApiPropertyOptional({ description: 'ID de la tienda (requerido para clientes)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  tiendaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoria?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  corridaId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  colorId?: number;

  @ApiPropertyOptional({ description: 'Buscar por nombre o código de producto' })
  @IsOptional()
  @IsString()
  busqueda?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  soloDisponibles?: boolean = true;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  pagina?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limite?: number = 20;
}
