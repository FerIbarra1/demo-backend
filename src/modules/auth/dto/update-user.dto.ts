import { IsString, IsOptional, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Juan' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  nombre?: string;

  @ApiPropertyOptional({ example: 'Pérez' })
  @IsOptional()
  @IsString()
  apellido?: string;

  @ApiPropertyOptional({ example: '555-1234' })
  @IsOptional()
  @IsString()
  telefono?: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({ example: 'passwordOld123' })
  @IsString()
  oldPassword: string;

  @ApiPropertyOptional({ example: 'passwordNew123', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
