import { IsEmail, IsString, MinLength, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'nuevo@cliente.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'Juan' })
  @IsString()
  @MinLength(2)
  nombre: string;

  @ApiPropertyOptional({ example: 'Pérez' })
  @IsOptional()
  @IsString()
  apellido?: string;

  @ApiProperty({
    example: '+525512345678',
    description: 'Teléfono en formato E.164 (con código de país)',
  })
  @IsString()
  @Matches(/^\+\d{6,15}$/, { message: 'telefono debe tener formato E.164 (+<6-15 dígitos>)' })
  telefono: string;
}