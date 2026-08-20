import { IsString, IsOptional, IsBoolean, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTiendaDto {
  @ApiProperty({ example: 'Punto Textil Mexicali' })
  @IsString()
  @Length(2, 100)
  nombre: string;

  @ApiProperty({ example: 'Blvd. Lázaro Cárdenas 481, Ex-Ejido Coahuila, C.P. 21360' })
  @IsString()
  @Length(5, 255)
  direccion: string;

  @ApiProperty({ example: 'Mexicali' })
  @IsString()
  @Length(2, 50)
  ciudad: string;

  @ApiProperty({ example: 'Baja California' })
  @IsString()
  @Length(2, 50)
  estado: string;

  @ApiPropertyOptional({ example: '686-000-0001' })
  @IsOptional()
  @IsString()
  telefono?: string;

  @ApiPropertyOptional({ example: 'mexicali@puntotextil.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}
