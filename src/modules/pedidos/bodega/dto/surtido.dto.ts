import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { EstadoSurtido } from '@prisma/client';

/**
 * F13 (sep 2026): el bodeguero SOLO reporta existencia. Se eliminó
 * `nuevoPrecioCOId` (la sustitución de producto/color/talla): proponer
 * variantes o productos distintos es tarea del asesor de ventas, que arma
 * una contrapropuesta completa al cliente.
 */
export class MarcarSurtidoItemDto {
  @ApiProperty({
    description: 'Cantidad realmente surtida (0 si no hay)',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  cantidadSurtida: number;

  @ApiProperty({
    enum: EstadoSurtido,
    description:
      'PENDIENTE: aún no se ha surtido. PARCIAL: se surtió menos de lo pedido. COMPLETO: se surtió todo. NO_DISPONIBLE: no se pudo surtir nada.',
  })
  @IsEnum(EstadoSurtido)
  estadoSurtido: EstadoSurtido;

  @ApiPropertyOptional({
    description:
      'Motivo del bodeguero cuando hay faltante (se persiste en ItemPedido.motivoSurtido).',
  })
  @IsOptional()
  @IsString()
  motivo?: string;
}

/**
 * F21 (oct 2026): el cierre del surtido ahora reporta QUÉ prendas se sacaron de
 * la bolsa del área de entrega.
 *
 * El checklist de retiro del sheet es obligatorio (hasta marcar cada prenda,
 * "Terminar surtido" queda bloqueado), pero esa marca vivía SOLO en estado local
 * del componente — al cerrar el sheet se perdía. Consecuencia: el sistema nunca
 * registraba que el retiro ya se hizo, así que un segundo ajuste sobre el mismo
 * pedido volvía a pedir sacar prendas que ya estaban fuera de la bolsa.
 *
 * El backend no puede inferirlo: `piezasFueraDeLaBolsa` compara `cantidadSurtida`
 * contra `cantidad`, y sacar mercancía físicamente no cambia ninguna de las dos.
 * Por eso hay que reportarlo explícitamente.
 *
 * Opcional a propósito: el lote (`BodegaLoteSheet`) confirma sin checklist porque
 * los pedidos con ajuste están excluidos de `obtenerLoteSurtirJuntos`, y los
 * callers/tests que no lo mandan conservan el comportamiento previo.
 */
export class ConfirmarSurtidoDto {
  @ApiPropertyOptional({
    description:
      'IDs de los items cuya mercancía ya se sacó de la bolsa. El backend suma ' +
      'sus piezas a `ItemPedido.piezasRetiradas` para no volver a pedirlas en un ' +
      'ajuste posterior.',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  itemsRetirados?: number[];
}
