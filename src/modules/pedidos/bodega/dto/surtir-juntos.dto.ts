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
    description:
      'IDs de pedidos del bodeguero (asignadoAId = me) que también pidieron este producto. ' +
      'Permite al frontend agrupar visualmente: "compartido con PD-001 y PD-002".',
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

export class SurtirJuntosResponseDto {
  @ApiProperty({
    type: [SurtirJuntosPedidoDto],
    description:
      'Top 10 pedidos en cola con productos compartidos con los pedidos que el bodeguero tiene asignados. ' +
      'Vacío si el bodeguero no tiene pedidos asignados o si ninguno tiene productos compartidos.',
  })
  data: SurtirJuntosPedidoDto[];
}
