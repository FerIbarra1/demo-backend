import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CODIGOS_MOTIVO_CANCELACION,
  MAX_DETALLE_MOTIVO,
} from '../../core/motivos-cancelacion-cliente';

/**
 * Oct 2026: lo que el cliente manda al cancelar su pedido. TODO es opcional: el body puede ir vacío.
 *
 * El motivo es para el negocio (analítica), no un requisito: la pantalla lo ofrece y se puede omitir sin fricción.
 * Las combinaciones inválidas (texto sin motivo, texto con un motivo que no es «Otro») las rechaza
 * `motivoElegido`, porque el servicio es frontera de confianza propia.
 */
export class CancelarPedidoDto {
  @ApiPropertyOptional({
    enum: CODIGOS_MOTIVO_CANCELACION,
    description: 'Por qué cancela (opcional). Ver GET cliente/pedidos/motivos-cancelacion.',
  })
  @IsOptional()
  @IsString()
  @IsIn(CODIGOS_MOTIVO_CANCELACION as string[], { message: 'Ese motivo no está en la lista.' })
  motivo?: string;

  @ApiPropertyOptional({
    maxLength: MAX_DETALLE_MOTIVO,
    description: 'Solo con el motivo «OTRO»: lo que el cliente escribió.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DETALLE_MOTIVO, {
    message: `Tu comentario es muy largo (máximo ${MAX_DETALLE_MOTIVO} caracteres).`,
  })
  detalle?: string;

  @ApiPropertyOptional({
    description:
      'El cliente confirma que TODAVÍA NO ha transferido. Obligatorio solo cuando el pedido tiene una ' +
      'transferencia pendiente (dinero posiblemente en camino): sin esto el servidor responde 409 ' +
      'CONFIRMAR_TRANSFERENCIA.',
  })
  @IsOptional()
  // El ValidationPipe de `main.ts` usa conversión implícita: sin esto el STRING "false" se volvería `true` y «confirmaría»
  // por error que no se transfirió. Se lee el valor crudo para que `@IsBoolean` rechace todo lo que no sea un booleano.
  @Transform(({ obj }) => obj.noHeTransferido)
  @IsBoolean()
  noHeTransferido?: boolean;
}
