import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  /**
   * Opcional: el refresh token normalmente viaja en la cookie httpOnly
   * (leída por el controller). Este campo es un fallback para clientes
   * legados que lo mandaban en el body.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
