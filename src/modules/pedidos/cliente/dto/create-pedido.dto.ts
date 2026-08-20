import {
  IsArray,
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  ValidateNested,
  Min,
  ArrayMinSize,
  IsEmail,
  MaxLength,
  Matches,
  IsBoolean,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CanalOrigen, ModoEntrega, Paqueteria } from '@prisma/client';

class ItemPedidoInputDto {
  @ApiProperty({ description: 'ID de PrecioCO (variante talla/color)' })
  @IsNumber()
  precioCOId: number;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  cantidad: number;
}

export class CreatePedidoDto {
  @ApiProperty({ type: [ItemPedidoInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemPedidoInputDto)
  @ArrayMinSize(1)
  items: ItemPedidoInputDto[];

  @ApiPropertyOptional({ enum: CanalOrigen, default: CanalOrigen.WEB })
  @IsOptional()
  @IsEnum(CanalOrigen)
  canalOrigen?: CanalOrigen;

  // B2B: captura de contacto al crear el pedido (no en checkout)
  @ApiProperty({ example: 'Juan Pérez' })
  @IsString()
  @MaxLength(100)
  clienteNombre: string;

  @ApiProperty({ example: 'juan@empresa.com' })
  @IsEmail()
  @MaxLength(100)
  clienteEmail: string;

  @ApiPropertyOptional({
    example: '+525512345678',
    description: 'Teléfono de contacto en formato E.164 (con código de país)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+\d{6,15}$/, { message: 'clienteTelefono debe tener formato E.164' })
  @MaxLength(20)
  clienteTelefono?: string;

  // ============ F8 (jul 2026): modo de entrega + datos logísticos ============
  // El backend infiere el modo si no llega. Los campos de envío/recogida
  // tienen requisitos distintos según el modo — ver PedidosService.crearPedido.

  @ApiPropertyOptional({
    enum: ModoEntrega,
    description:
      'Modo de entrega. Si se omite, el backend lo infiere: KIOSKO si canalOrigen=KIOSKO, DOMICILIO si hay dirección, RECOGER_TIENDA si hay recogerProgramado.',
  })
  @IsOptional()
  @IsEnum(ModoEntrega)
  modoEntrega?: ModoEntrega;

  // Envío (sólo DOMICILIO)
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shippingDireccion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  shippingReferencia?: string;

  @ApiPropertyOptional({ description: 'Requerido si modoEntrega=DOMICILIO' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  shippingColonia?: string;

  @ApiPropertyOptional({ description: 'Requerido si modoEntrega=DOMICILIO (5 dígitos)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{5}$/, { message: 'El código postal debe tener 5 dígitos' })
  shippingCodigoPostal?: string;

  @ApiPropertyOptional({
    enum: Paqueteria,
    description:
      'Requerido si modoEntrega=DOMICILIO y dejarAdminDecidePaqueteria=false. Mutuamente excluyente con dejarAdminDecidePaqueteria=true.',
  })
  @IsOptional()
  @IsEnum(Paqueteria)
  shippingPaqueteria?: Paqueteria;

  @ApiPropertyOptional({
    description:
      'Si true, el cliente delega la elección de paquetería al admin (shippingPaqueteria queda NULL). Mutuamente excluyente con shippingPaqueteria.',
  })
  @IsOptional()
  @IsBoolean()
  dejarAdminDecidePaqueteria?: boolean;

  // Recogida (sólo RECOGER_TIENDA; kiosko no usa)
  @ApiPropertyOptional({
    description:
      'Fecha+hora exactas en que el cliente pasará a recoger. Requerido si modoEntrega=RECOGER_TIENDA. Validado con isValidPickupSlot.',
  })
  @IsOptional()
  @IsDateString()
  recogerProgramado?: string;

  // Notas libres del cliente
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
