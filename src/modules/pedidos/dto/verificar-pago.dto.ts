import { IsBoolean, IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerificarPagoDto {
  @ApiProperty()
  @IsBoolean()
  aprobado: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observacion?: string;
}
