import { IsString, IsOptional, IsBoolean, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTiendaDto {
  @ApiProperty({ example: 'Sucursal Centro' })
  @IsString()
  @Length(2, 100)
  nombre: string;

  @ApiProperty({ example: 'Calle Principal 123' })
  @IsString()
  @Length(5, 255)
  direccion: string;

  @ApiProperty({ example: 'Ciudad de México' })
  @IsString()
  @Length(2, 50)
  ciudad: string;

  @ApiProperty({ example: 'CDMX' })
  @IsString()
  @Length(2, 50)
  estado: string;

  @ApiPropertyOptional({ example: '555-0100' })
  @IsOptional()
  @IsString()
  telefono?: string;

  @ApiPropertyOptional({ example: 'centro@tienda.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
