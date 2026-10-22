import { IsEmail, IsString, MinLength, Matches } from 'class-validator';
import { PASSWORD_MENSAJE, PASSWORD_MIN, PASSWORD_PATRON } from '../../../common/password-policy';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'cliente@ejemplo.com' })
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    example: 'a1b2c3d4...',
    description: 'Token recibido por email al solicitar recuperación',
  })
  @IsString()
  token: string;

  @ApiProperty({ example: 'nuevaPassword123', minLength: 8 })
  @IsString()
  @MinLength(PASSWORD_MIN, { message: PASSWORD_MENSAJE })
  @Matches(PASSWORD_PATRON, { message: PASSWORD_MENSAJE })
  newPassword: string;
}
