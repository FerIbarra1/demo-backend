import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsObject,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SyncEventoDto {
  @ApiProperty({ example: 'BANDEJA:93847:PRECIOS:5' })
  @IsString()
  @MaxLength(160)
  eventId: string;

  @ApiProperty({ example: 93847 })
  @IsInt()
  @Min(0)
  bandejaId: number;

  @ApiProperty({
    example: 'CATALOGO',
    description: 'Tipo de evento (afecta qué handler lo procesa)',
  })
  @IsIn(['CATALOGO', 'CLIENTE', 'PEDIDO', 'PAGO'])
  tipo: 'CATALOGO' | 'CLIENTE' | 'PEDIDO' | 'PAGO';

  @ApiProperty({ example: 'I', description: 'Operación: I=insert, U=update, D=delete' })
  @IsIn(['I', 'U', 'D'])
  operacion: 'I' | 'U' | 'D';

  @ApiProperty({
    example: 'PRECIOS',
    description:
      'Entidad local de Firebird (PRECIOS, PRECIOSCO, PRODUCTOS, CORRIDAS, COLORES, CLIENTES, CLIENTESCXC, VENDEDORES, PEDIDOS, etc.)',
  })
  @IsString()
  @MaxLength(40)
  entidad: string;

  @ApiProperty({ example: 12345, description: 'IDTABLA en Firebird (BANDEJA_SYNC.IDTABLA)' })
  @IsInt()
  @Min(0)
  localId: number;

  @ApiProperty({
    example: 5,
    required: false,
    description: 'IDTIENDA en Firebird. Omitir para entidades globales.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  localTiendaId?: number;

  @ApiProperty({
    description:
      'Datos del registro ya leídos por el agente desde Firebird. Shape depende de la entidad.',
  })
  @IsObject()
  datos: Record<string, unknown>;
}

export class UploadBatchDto {
  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(0)
  tiendaId: number;

  @ApiProperty({
    example: 93847,
    description:
      'Último BANDEJA_SYNC.ID incluido en este batch. El servidor avanza el checkpoint a este ID sólo tras procesar exitosamente.',
  })
  @IsInt()
  @Min(0)
  hastaBANDEJAId: number;

  @ApiProperty({ type: [SyncEventoDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncEventoDto)
  eventos: SyncEventoDto[];
}
