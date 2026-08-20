import { IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class KioskLoginDto {
  @ApiProperty({ description: 'Token de kiosko generado por GET /auth/kiosk-token' })
  @IsString()
  kioskToken: string;

  @ApiProperty({ description: 'Tienda desde la que se está logueando' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tiendaId: number;
}
