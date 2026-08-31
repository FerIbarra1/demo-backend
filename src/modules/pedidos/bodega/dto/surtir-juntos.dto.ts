import { ApiProperty } from '@nestjs/swagger';
import { CanalOrigen } from '@prisma/client';

export class SurtirJuntosItemDto {
  @ApiProperty({
    description: 'ID del producto compartido entre pedidos.',
  })
  productoId: number;

  @ApiProperty({
    description: 'Nombre snapshot del producto.',
  })
  productoNombre: string;

  @ApiProperty({
    description: 'Cantidad pedida por el cliente en este pedido.',
  })
  cantidad: number;

  @ApiProperty({
    description: 'ID del color de la zona compartida (null si el item no tiene color).',
    nullable: true,
  })
  colorId: number | null;

  @ApiProperty({
    description: 'Nombre del color de la zona compartida.',
    nullable: true,
  })
  colorNombre: string | null;

  @ApiProperty({
    description: 'Hex del color para el swatch visual.',
    nullable: true,
  })
  colorHex: string | null;

  @ApiProperty({
    description:
      'IDs de pedidos del bodeguero (asignadoAId = me) que también pidieron esta zona ' +
      '(mismo producto + color). Permite al frontend agrupar visualmente: "compartido con PD-001 y PD-002".',
    type: [Number],
  })
  pedidosCompartidosCon: number[];
}

export class SurtirJuntosPedidoDto {
  @ApiProperty()
  id: number;

  @ApiProperty({
    description: 'Número de pedido legible, ej. "PD-2026-000123".',
  })
  numeroPedido: string;

  @ApiProperty()
  clienteNombre: string;

  @ApiProperty({ enum: CanalOrigen })
  canalOrigen: CanalOrigen;

  @ApiProperty({
    description: 'Minutos desde fechaPedido hasta ahora (calculado en backend).',
  })
  minutosEnCola: number;

  @ApiProperty({
    description:
      'Cantidad de productos que este pedido comparte con los pedidos del bodeguero. ' +
      'Es el motor de "surtir juntos" — si es 0 el pedido no aparece en la respuesta.',
  })
  itemsCompartidos: number;

  @ApiProperty({
    description:
      'Score de similitud (mayor = más relevante). Fórmula: ' +
      '10 por precioCOId compartido + 4 por productoId compartido + 1 por minuto en cola. ' +
      'El frontend ordena por score descendente.',
  })
  score: number;

  @ApiProperty({
    description: 'Items compartidos con detalle (producto + cantidad + con quién).',
    type: [SurtirJuntosItemDto],
  })
  items: SurtirJuntosItemDto[];
}

// ==================== MODO LOTE (F11) ====================

export class LoteItemDto {
  @ApiProperty()
  itemId: number;

  @ApiProperty()
  pedidoId: number;

  @ApiProperty()
  numeroPedido: string;

  @ApiProperty()
  tallaNombre: string;

  @ApiProperty()
  corridaNombre: string;

  @ApiProperty()
  cantidad: number;

  @ApiProperty()
  cantidadSurtida: number;

  @ApiProperty()
  estadoSurtido: string;

  @ApiProperty({ nullable: true })
  motivoSurtido: string | null;
}

export class ZonaLoteDto {
  @ApiProperty()
  productoId: number;

  @ApiProperty()
  productoNombre: string;

  @ApiProperty({ nullable: true })
  colorId: number | null;

  @ApiProperty({ nullable: true })
  colorNombre: string | null;

  @ApiProperty({ nullable: true })
  colorHex: string | null;

  @ApiProperty({ type: [LoteItemDto] })
  items: LoteItemDto[];
}

export class PedidoLoteResumenDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  numeroPedido: string;

  @ApiProperty()
  clienteNombre: string;

  @ApiProperty()
  estado: string;

  @ApiProperty()
  total: number;
}

export class LoteSurtirJuntosDto {
  @ApiProperty({ type: [ZonaLoteDto] })
  zonas: ZonaLoteDto[];

  @ApiProperty({ type: [PedidoLoteResumenDto] })
  pedidos: PedidoLoteResumenDto[];
}
