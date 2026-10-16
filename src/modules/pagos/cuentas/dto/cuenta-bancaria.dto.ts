import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const limpiar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CrearCuentaBancariaDto {
  @ApiPropertyOptional({
    example: 3,
    description: 'Tienda a la que pertenece la cuenta. Sin ella, es la cuenta GLOBAL.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;

  @ApiProperty({ example: 'BBVA' })
  @Transform(limpiar)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  banco: string;

  @ApiProperty({ example: 'PUNTO TEXTIL SA DE CV' })
  @Transform(limpiar)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  titular: string;

  @ApiProperty({
    example: '012180001234567899',
    description: '18 dígitos con dígito de control válido.',
  })
  @IsString()
  @Matches(/^[\d\s-]{18,24}$/, { message: 'clabe debe tener 18 dígitos' })
  clabe: string;

  @ApiPropertyOptional({ example: '0123456789' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(20)
  cuenta?: string;

  @ApiPropertyOptional({ description: 'Texto extra que se agrega a las instrucciones.' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  instrucciones?: string;
}

export class ActualizarCuentaBancariaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  banco?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  titular?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]{18,24}$/, { message: 'clabe debe tener 18 dígitos' })
  clabe?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(20)
  cuenta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  instrucciones?: string;

  @ApiPropertyOptional({
    description: 'true = la activa (desactiva la anterior del mismo ámbito).',
  })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
