import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CODIGOS_MOTIVO_RECHAZO, type MotivoRechazo } from '../reglas';

const limpiar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
/** Monto en pesos con a lo más 2 decimales. Nunca viaja un total calculado por el cliente. */
const MONTO = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

/**
 * Campos que el cliente DECLARA al subir un comprobante. Son ayuda para que Tesorería encuentre el
 * abono en el banco; nunca se confía en ellos (el monto que cuenta es el que Tesorería ve en el
 * banco). Llegan como multipart, así que todo viene como texto.
 */
export class SubirComprobanteDto {
  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(MONTO)
  @IsPositive()
  montoDeclarado?: number;

  @ApiPropertyOptional({ example: '2026-10-16T15:30:00.000Z' })
  @IsOptional()
  @IsDateString()
  fechaDeclarada?: string;

  @ApiPropertyOptional({ example: 'BBVA' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(60)
  bancoEmisor?: string;

  @ApiPropertyOptional({ example: 'MBAN01002610160123456789' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(40)
  claveRastreoDeclarada?: string;
}

export class AprobarPagoDto {
  @ApiProperty({ example: 1500, description: 'Lo que Tesorería VIO en el estado de cuenta.' })
  @Type(() => Number)
  @IsNumber(MONTO)
  @IsPositive()
  montoRecibido: number;

  @ApiProperty({ example: '2026-10-16T15:30:00.000Z', description: 'Cuándo se reflejó el abono.' })
  @IsDateString()
  abonoFecha: string;

  @ApiPropertyOptional({ example: 'MBAN01002610160123456789' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @Matches(/^[A-Za-z0-9]{5,40}$/, {
    message: 'claveRastreo: 5 a 40 letras o números, sin espacios',
  })
  claveRastreo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  nota?: string;

  @ApiProperty({
    description:
      'Debe ser true: Tesorería confirma que vio el abono en el estado de cuenta (la imagen del comprobante no basta).',
  })
  @Equals(true, { message: 'Confirma que viste el abono en el estado de cuenta' })
  confirmoEnBanco: boolean;
}

export class RechazarPagoDto {
  @ApiProperty({ enum: CODIGOS_MOTIVO_RECHAZO })
  @IsIn(CODIGOS_MOTIVO_RECHAZO)
  motivo: MotivoRechazo;

  @ApiPropertyOptional({ description: 'Obligatoria con el motivo OTRO.' })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  nota?: string;

  @ApiPropertyOptional({
    description: 'Si se omite, se rechazan todos los comprobantes por revisar.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  comprobanteId?: number;
}

/** Llegó un abono pero el pedido ya no está pendiente de pago (cancelado, cobrado o el pago venció). */
export class AbonoSinPedidoDto {
  @ApiProperty({ example: 1500 })
  @Type(() => Number)
  @IsNumber(MONTO)
  @IsPositive()
  montoRecibido: number;

  @ApiProperty()
  @IsDateString()
  abonoFecha: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @Matches(/^[A-Za-z0-9]{5,40}$/, {
    message: 'claveRastreo: 5 a 40 letras o números, sin espacios',
  })
  claveRastreo?: string;

  @ApiProperty({ description: 'Qué pasó (obligatoria: queda en la bitácora del reembolso).' })
  @Transform(limpiar)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  nota: string;

  @ApiProperty()
  @Equals(true, { message: 'Confirma que viste el abono en el estado de cuenta' })
  confirmoEnBanco: boolean;
}

export class RegistrarReembolsoDto {
  @ApiProperty({
    example: 'SPEI 2026101601234',
    description: 'Clave de rastreo o referencia de la devolución.',
  })
  @Transform(limpiar)
  @IsString()
  @MinLength(5)
  @MaxLength(60)
  referencia: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(500)
  nota?: string;
}

/** Marcar vencidas unas instrucciones. Sin plazo que lo justifique, el motivo es obligatorio. */
export class VencerPagoDto {
  @ApiProperty({
    example: 'El cliente avisó que ya no va a transferir.',
    description: 'Por qué se cierran. Queda en la bitácora del pago.',
  })
  @Transform(limpiar)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo: string;
}

export class ResolverRevisionDto {
  @ApiProperty({ description: 'Qué se aclaró. Queda en la bitácora.' })
  @Transform(limpiar)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  nota: string;
}

export class ReenviarInstruccionesDto {
  @ApiPropertyOptional({
    description: 'Correo alterno (si el del pedido no le llega). Queda registrado.',
  })
  @IsOptional()
  @Transform(limpiar)
  @IsEmail()
  @MaxLength(100)
  email?: string;
}

export const GRUPOS_PAGO = [
  'por-revisar',
  'esperando',
  'verificados',
  'reembolsos',
  'requieren-revision',
  'historial',
] as const;
export type GrupoPago = (typeof GRUPOS_PAGO)[number];

export class ListarPagosQueryDto {
  @ApiPropertyOptional({ enum: GRUPOS_PAGO, default: 'por-revisar' })
  @IsOptional()
  @IsIn(GRUPOS_PAGO)
  grupo?: GrupoPago;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;

  @ApiPropertyOptional({
    description:
      'Busca por folio web, folio VFP, referencia, nombre, correo, teléfono, monto o clave de rastreo.',
  })
  @IsOptional()
  @Transform(limpiar)
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite?: number;
}

/** Rango de días del NEGOCIO (no de UTC) para el reporte de conciliación. */
export class ConciliacionQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'Primer día (YYYY-MM-DD, zona del negocio). Por omisión, hace 6 días.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'desde debe ser YYYY-MM-DD' })
  desde?: string;

  @ApiPropertyOptional({
    example: '2026-10-16',
    description: 'Último día incluido (YYYY-MM-DD). Por omisión, hoy.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'hasta debe ser YYYY-MM-DD' })
  hasta?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tiendaId?: number;
}
