import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cuerpo de `POST kiosko/llegada/consultar` y `/confirmar`.
 *
 * Antes era un tipo inline (`{ qr?: string; folio?: string }`): un tipo literal no tiene metadatos para el
 * `ValidationPipe`, así que NADA se validaba (ni el largo, ni que fueran strings, ni los campos de más).
 * Con una clase, `whitelist` + `forbidNonWhitelisted` sí actúan.
 *
 * Dos formas de identificarse:
 *  - `qr`: el token firmado (la firma es la prueba; no pide nada más).
 *  - `folio` + `telefono4`: lo que el cliente TECLEA. El folio es público (sale en el ticket y en la
 *    TV), así que se exige un segundo factor: los últimos 4 dígitos de SU teléfono.
 */
export class ResolverLlegadaDto {
  @ApiPropertyOptional({ description: 'Token firmado del QR (`PT1.…`). No pide teléfono.' })
  @IsOptional()
  @IsString()
  @MaxLength(700)
  qr?: string;

  @ApiPropertyOptional({
    description:
      'Folio tecleado: `HMO-0000152573`, `0000152573`, `152573` o el número interno `PD-…`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  folio?: string;

  @ApiPropertyOptional({
    description: 'Últimos 4 dígitos del teléfono del pedido. Obligatorio cuando se manda `folio`.',
    example: '4567',
  })
  @ValidateIf((o: ResolverLlegadaDto) => o.folio !== undefined && !o.qr)
  @IsString()
  @Matches(/^\d{4}$/, { message: 'telefono4 debe ser de exactamente 4 dígitos' })
  telefono4?: string;
}
