import { IsEmail, IsString, MinLength } from 'class-validator';
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

  @ApiProperty({ example: 'nuevaPassword123', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
