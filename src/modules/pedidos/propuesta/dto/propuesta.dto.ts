import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * F12 (sep 2026): item de una propuesta de ajuste que bodega envía al cliente.
 * Mismo shape que el frontend `lib/propuesta.ts` (ItemPropuesta), para que el
 * snapshot sea directamente renderizable.
 */
export class PropuestaItemDto {
  @ApiProperty({ description: 'itemId real del pedido (>=1) o tempId negativo para agregados' })
  @IsInt()
  itemId: number;

  @ApiProperty({
    enum: ['completo', 'cambio', 'no-disponible', 'parcial', 'agregado'],
  })
  @IsString()
  tipo: string;

  @ApiProperty()
  @IsString()
  producto: string;

  /**
   * F21 (oct 2026): el código del producto (ej. "C0200").
   *
   * Faltaba en el DTO de ENTRADA aunque el editor lo manda en TODAS sus ramas
   * desde oct 2026. Con `forbidNonWhitelisted: true` en el `ValidationPipe`
   * global, eso significa que **ninguna propuesta del asesor se podía enviar**:
   * el request moría con 400 antes de llegar al servicio.
   *
   * No lo veía ningún test porque todos llaman a los utils directamente, sin
   * pasar por el pipe. Ver `propuesta-dto.spec.ts`, que existe justo para esto.
   */
  @ApiPropertyOptional({ description: 'Código del producto (ej. "C0200").' })
  @IsOptional()
  @IsString()
  productoCodigo?: string | null;

  @ApiProperty()
  @IsString()
  variante: string;

  @ApiPropertyOptional({ description: 'Imagen del producto (del color pedido).' })
  @IsOptional()
  @IsString()
  productoImagen?: string | null;

  @ApiProperty()
  @IsInt()
  @Min(0)
  cantidad: number;

  @ApiProperty()
  @IsNumber()
  precioUnitario: number;

  @ApiProperty()
  @IsNumber()
  subtotal: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productoOriginal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  varianteOriginal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cantidadOriginal?: number;
  /** true solo si ventas/mostrador editó explícitamente esta línea. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ajusteExplicito?: boolean;

  /**
   * F21 (oct 2026): lo que HAY en el anaquel, cuando difiere de lo que se lleva.
   *
   * Tiene que estar declarado aquí, no solo en `ItemPropuestaJson`: el
   * `ValidationPipe` global corre con `forbidNonWhitelisted: true`, así que un
   * campo fuera del DTO **rechaza el request con 400**. El editor de ventas manda
   * la propuesta completa por `POST /pedidos/:id/mensajes/con-adjunto`, así que
   * sin esta declaración el asesor no podría enviar ninguna propuesta que ajuste
   * una cantidad — el flujo se rompe en producción, no en los tests (que llaman
   * a los utils directamente y no pasan por el pipe).
   */
  @ApiPropertyOptional({ description: 'Lo que hay en el anaquel, si difiere de lo que se lleva.' })
  @IsOptional()
  @IsInt()
  cantidadDisponible?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productoNuevo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  varianteNueva?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  cantidadNueva?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  precioUnitarioNuevo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  subtotalNuevo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  tempId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  productoId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  precioCOId?: number;
}

export class CrearPropuestaDto {
  @ApiProperty({ type: [PropuestaItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PropuestaItemDto)
  items: PropuestaItemDto[];

  @ApiProperty({
    description:
      'Total propuesto. El backend lo RECALCULA desde los items y lo ignora: ' +
      'ahora que el asesor de ventas propone precios, confiar en este valor ' +
      'permitiría aprobar un número distinto al que se cobra.',
  })
  @IsNumber()
  @Min(0)
  total: number;

  @ApiPropertyOptional({ description: 'Nota libre del autor que acompaña la propuesta' })
  @IsOptional()
  @IsString()
  nota?: string;
}

/**
 * F13 (sep 2026): decisiones del cliente. Cuáles son legales depende del
 * ORIGEN de la propuesta (ver `PropuestaService.DECISIONES_POR_ORIGEN`):
 *
 *   Propuesta de BODEGA: APROBAR | RECHAZAR | CONTACTAR_ASESOR
 *   Propuesta de VENTAS: APROBAR | RECHAZAR | CANCELAR_PEDIDO
 *
 * El backend valida, no confía en el frontend.
 */
export type DecisionPropuesta = 'APROBAR' | 'RECHAZAR' | 'CONTACTAR_ASESOR' | 'CANCELAR_PEDIDO';

export class ResponderPropuestaDto {
  @ApiProperty({ enum: ['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'] })
  @IsIn(['APROBAR', 'RECHAZAR', 'CONTACTAR_ASESOR', 'CANCELAR_PEDIDO'])
  decision: DecisionPropuesta;

  /**
   * Oct 2026: el texto del cliente.
   *
   * OBLIGATORIO cuando pide ajustes (`CONTACTAR_ASESOR`). No es una nota
   * interna: es el PRIMER mensaje del chat con el asesor y el único contexto
   * que él recibe para saber qué ajustar. Sin él, el asesor abre la
   * conversación con un "quiero ajustes" y nada más, y tiene que preguntar
   * todo por chat — que es justo lo que este cambio evita.
   *
   * Opcional en el resto de las decisiones, donde sigue siendo el motivo libre
   * que alimenta `PedidoPropuesta.notaCliente` (el motivo del rechazo, la
   * cancelación con su lista de reposición).
   */
  @ApiPropertyOptional({
    description:
      'Texto del cliente. Obligatorio al pedir ajustes (CONTACTAR_ASESOR): ' +
      'es el primer mensaje del chat con el asesor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  @ValidateIf((o) => o.decision === 'CONTACTAR_ASESOR')
  @IsNotEmpty({
    message: 'Cuéntanos qué cambios quieres en tu pedido para que el asesor pueda hacer el ajuste.',
  })
  nota?: string;
}

/**
 * Un item de la propuesta tal como se guarda en `PedidoPropuesta.items` (JSON).
 *
 * Es la forma SERIALIZADA del snapshot: la propuesta guarda el item completo
 * para que la tarjeta del chat pueda mostrar la foto, el productoId (para
 * resolver la imagen de un `agregado`) y el "antes" de los tipos `cambio` y
 * `parcial`, sin volver a consultar el pedido.
 *
 * Vivía declarada al final de `propuesta.service.ts`; se movió aquí porque es
 * un tipo de transporte, no de servicio.
 */
export interface ItemPropuestaJson {
  itemId: number;
  tipo: 'completo' | 'cambio' | 'no-disponible' | 'parcial' | 'agregado';
  producto: string;
  /**
   * Oct 2026: el código del producto (ej. "C0200").
   *
   * Faltaba, y es el dato que el personal usa para identificar la prenda: en
   * tienda la etiqueta física trae el código y el cliente compara contra lo que
   * ve en pantalla. Sin él la tarjeta de la propuesta mostraba nombre, talla y
   * color — todo lo que NO está impreso en la prenda.
   *
   * Se guarda en el snapshot (y no se resuelve en el frontend) para que cubra
   * también los productos que el asesor AGREGA, que no existen en
   * `pedido.items` y por tanto no tendrían de dónde sacarlo.
   */
  productoCodigo?: string | null;
  variante: string;
  productoImagen?: string | null;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  productoOriginal?: string;
  varianteOriginal?: string;
  cantidadOriginal?: number;
  /** true solo si ventas/mostrador editó explícitamente esta línea. */
  ajusteExplicito?: boolean;
  /**
   * F21 (oct 2026): lo que HAY en el anaquel, cuando difiere de lo que el cliente
   * se lleva.
   *
   * Es el número del medio en "Pediste 5 · Hay 3 · Te llevas 1". Sin él, la
   * tarjeta de la propuesta solo puede pintar dos de los tres hechos — y el que
   * se cae es justo "había 3", que es lo que le dice al cliente que no le están
   * dando de menos.
   *
   * Se omite cuando coincide con `cantidadNueva`: no hay nada que aclarar.
   */
  cantidadDisponible?: number;
  productoNuevo?: string;
  varianteNueva?: string;
  cantidadNueva?: number;
  precioUnitarioNuevo?: number;
  subtotalNuevo?: number;
  tempId?: number;
  productoId?: number;
  precioCOId?: number;
}
