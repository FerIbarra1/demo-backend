import {
  IsArray,
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  ValidateNested,
  Min,
  IsEmail,
  MaxLength,
  Matches,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CanalOrigen, MetodoPago, ModoEntrega, Paqueteria } from '@prisma/client';

class ItemPedidoInputDto {
  @ApiProperty({ description: 'ID de PrecioCO (variante talla/color)' })
  @IsNumber()
  precioCOId: number;

  @ApiProperty({ minimum: 1 })
  @IsNumber()
  @Min(1)
  cantidad: number;
}

/** Oct 2026 (impresión DTF): un trabajo DTF ya creado como borrador (con su archivo) que se agrega al pedido. */
class DtfPedidoInputDto {
  @ApiProperty({ description: 'ID del borrador DTF (POST /dtf/borradores)' })
  @IsNumber()
  trabajoId: number;

  @ApiPropertyOptional({
    description: 'true: el archivo se entregará en tienda (USB/correo) y lo adjunta el personal.',
  })
  @IsOptional()
  @IsBoolean()
  sinArchivo?: boolean;
}

export class CreatePedidoDto {
  // Oct 2026: las prendas ya no son obligatorias (un pedido puede ser solo DTF). El servicio exige que
  // haya al menos una prenda o un trabajo DTF.
  @ApiPropertyOptional({ type: [ItemPedidoInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemPedidoInputDto)
  items?: ItemPedidoInputDto[];

  @ApiPropertyOptional({
    type: [DtfPedidoInputDto],
    description: 'Trabajos DTF (impresión por metro) del pedido.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DtfPedidoInputDto)
  dtf?: DtfPedidoInputDto[];

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
      'Modo de entrega. Si se omite, el backend lo infiere: KIOSKO si canalOrigen=KIOSKO, DOMICILIO si hay dirección.',
  })
  @IsOptional()
  @IsEnum(ModoEntrega)
  modoEntrega?: ModoEntrega;

  // Envío (solo DOMICILIO)
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

  @ApiPropertyOptional({
    enum: MetodoPago,
    description:
      'Cómo piensa pagar. NO vincula nada: solo preselecciona la opción cuando el pedido esté listo ' +
      'para pagar. Se ignora en pedidos a domicilio.',
  })
  @IsOptional()
  @IsEnum(MetodoPago)
  metodoPagoPreferido?: MetodoPago;

  // Notas libres del cliente
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notas?: string;
}
