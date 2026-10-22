import { IsString, IsOptional, MinLength, Matches } from 'class-validator';
import { PASSWORD_MENSAJE, PASSWORD_MIN, PASSWORD_PATRON } from '../../../common/password-policy';
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

  @ApiPropertyOptional({
    example: '+525512345678',
    description: 'Teléfono en formato E.164 (con código de país). Si se omite, no se modifica.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+\d{6,15}$/, { message: 'telefono debe tener formato E.164 (+<6-15 dígitos>)' })
  telefono?: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({ example: 'passwordOld123' })
  @IsString()
  oldPassword: string;

  @ApiPropertyOptional({ example: 'passwordNew123', minLength: 8 })
  @IsString()
  @MinLength(PASSWORD_MIN, { message: PASSWORD_MENSAJE })
  @Matches(PASSWORD_PATRON, { message: PASSWORD_MENSAJE })
  newPassword: string;
}
