import { ApiProperty } from '@nestjs/swagger';

class UserResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  email: string;

  @ApiProperty()
  nombre: string;

  @ApiProperty()
  rol: string;

  @ApiProperty({ required: false })
  tiendaId?: number;

  @ApiProperty({ required: false, description: 'Teléfono en formato E.164 (ej. +525512345678)' })
  telefono?: string;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty({ description: 'Id del refresh token persistido en BD (para revocación explícita)' })
  refreshTokenId: number;

  @ApiProperty()
  expiresIn: number;

  @ApiProperty({ type: UserResponseDto })
  user: UserResponseDto;
}
