import { IsInt, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * La tablet pide un emparejamiento. El `deviceSecretHash` es el SHA-256 de un
 * secreto que la tablet genera y NUNCA sale de su memoria: es lo que autoriza
 * el reclamo del token. El secreto en claro no viaja ni se persiste.
 */
export class SolicitarPairingDto {
  @ApiProperty({
    description: 'SHA-256 (hex) del secreto que generó la tablet. Autoriza el reclamo.',
    example: 'a'.repeat(64),
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'deviceSecretHash debe ser un SHA-256 en hex' })
  deviceSecretHash: string;

  @ApiPropertyOptional({ description: 'Pista: tienda a la que cree pertenecer (no autoriza nada)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaIdHint?: number;

  @ApiPropertyOptional({ description: 'Pista: kiosko al que cree pertenecer (no autoriza nada)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  kioskoIdHint?: number;
}

/** La tablet reclama el token. Exige el secreto en claro, no sólo el id. */
export class ReclamarPairingDto {
  @ApiProperty({ description: 'Secreto de 32 bytes en base64url que la tablet guarda en memoria' })
  @IsString()
  @Length(20, 200)
  deviceSecret: string;
}

/** El admin autoriza la vinculación a un kiosko concreto. */
export class AprobarPairingDto {
  @ApiProperty({ description: 'Kiosko al que se vincula esta tablet' })
  @Type(() => Number)
  @IsInt()
  kioskoId: number;
}

/** El admin busca la solicitud por el código que le leyó el encargado. */
export class BuscarPairingQueryDto {
  @ApiProperty({ description: 'Código de 6 dígitos que muestra la tablet' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' })
  code: string;
}
