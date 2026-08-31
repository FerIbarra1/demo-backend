import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SubirImagenDto {
  @ApiPropertyOptional({
    description:
      'ID del color al que pertenece la imagen. Omitir (o null) para una imagen general del producto.',
    example: 3,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  colorId?: number;
}
