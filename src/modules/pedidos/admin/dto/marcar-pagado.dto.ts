import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body de `POST /admin/pedidos/:id/marcar-pagado`.
 *
 * Antes era un tipo en línea (`{ fechaPago?: string; referencia?: string }`), y un tipo
 * en línea NO se valida: el `ValidationPipe` global solo actúa sobre clases. Una
 * `referencia` de 10 MB o una `fechaPago` que no es fecha entraban tal cual.
 *
 * `referencia` sigue siendo opcional a propósito: la pantalla de admin dice
 * "Referencia (opcional)". Exigirla es parte de los pagos por transferencia (ahí sí
 * importa quién y por qué), y requiere cambiar esa pantalla a la vez.
 */
export class MarcarPagadoDto {
  @ApiPropertyOptional({ example: '2026-10-15T18:30:00.000Z', description: 'ISO 8601' })
  @IsOptional()
  @IsDateString()
  fechaPago?: string;

  @ApiPropertyOptional({ example: 'FIREBIRD-12345', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @ApiPropertyOptional({
    description:
      'Solo para ADMIN: cobrar a mano un pedido que tiene una transferencia en curso (sin verificar). ' +
      'Exige `referencia` con el motivo. Existe porque cobrar en caja con una transferencia abierta puede ser un doble pago.',
  })
  @IsOptional()
  @IsBoolean()
  forzar?: boolean;
}
