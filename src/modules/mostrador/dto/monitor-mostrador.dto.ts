import { ApiProperty } from '@nestjs/swagger';
import { CanalOrigen } from '@prisma/client';

/**
 * F16 (sep 2026): snapshot del monitor de mostrador.
 *
 * A diferencia del monitor de cajero (agrupado por ventanilla) y del de bodega
 * (agrupado por canal), este es una COLA LINEAL: el operador manda a llamar al
 * siguiente conforme al orden. Es el modelo "TV bancaria" que el negocio pidió
 * (decisión D16): el cliente ve su pedido aparecer en la pantalla y sabe que le
 * toca pasar a revisarlo.
 *
 * No hay urgencia ni tiempo de espera (decisión D13): en mostrador el pedido
 * espera al CLIENTE, no al revés. Marcar como "crítico" un pedido cuyo cliente
 * aún no llega sería ruido.
 */

export class MonitorMostradorPedidoDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty() clienteNombre: string;
  @ApiProperty({ enum: CanalOrigen }) canalOrigen: CanalOrigen;
  @ApiProperty() itemsCount: number;
  @ApiProperty() total: number;
  @ApiProperty() fechaPedido: string;
  @ApiProperty({
    description: 'Minutos desde que el pedido entró a la cola de mostrador',
  })
  minutosEnCola: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Cuándo avisó llegada el cliente (null = no ha avisado)',
  })
  llegadaAnunciadaAt: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Minutos que el cliente lleva esperando en tienda',
  })
  esperandoDesdeMin: number | null;
  @ApiProperty({
    description:
      'true si hay un cliente identificado esperando en tienda (avisó llegada)',
  })
  clienteEnTienda: boolean;
}

export class MonitorMostradorContadoresDto {
  @ApiProperty({ description: 'Pedidos en la cola de mostrador' })
  enCola: number;
  @ApiProperty({
    description: 'Pedidos que el operador ya mandó a llamar (panel Atendiendo)',
  })
  atendiendo: number;
  @ApiProperty({ description: 'De los anteriores, cuántos tienen cliente en tienda' })
  enTienda: number;
  @ApiProperty({ description: 'Pedidos pagados esperando entrega al cliente' })
  listosParaEntregar: number;
  /**
   * F16 (§5.4): pedidos listos que NADIE ha venido a recoger.
   *
   * El gate de D5 esconde los pedidos web hasta que el cliente avisa llegada,
   * así que uno sin aviso es invisible en la cola. Si el cliente nunca llega,
   * se queda ahí para siempre sin que nadie lo note. Este contador es la señal
   * para perseguirlos.
   */
  @ApiProperty({ description: 'Pedidos listos sin cliente en tienda (nadie los ha recogido)' })
  sinCliente: number;
}

export class MonitorMostradorSinClienteDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty() clienteNombre: string;
  @ApiProperty({
    description: 'Minutos desde que se creó el pedido (antigüedad para priorizar)',
  })
  minutosEsperando: number;
}

export class MonitorMostradorResponseDto {
  @ApiProperty() timestamp: string;
  @ApiProperty() tiendaId: number;
  @ApiProperty() tiendaNombre: string;
  @ApiProperty({ type: [MonitorMostradorPedidoDto] })
  cola: MonitorMostradorPedidoDto[];
  @ApiProperty({
    type: [MonitorMostradorPedidoDto],
    description:
      'F16: pedidos ya llamados, del más reciente al más viejo. El primero es ' +
      'el que está enfrente del mostrador ahora mismo.',
  })
  atendiendo: MonitorMostradorPedidoDto[];
  @ApiProperty({ type: MonitorMostradorContadoresDto })
  contadores: MonitorMostradorContadoresDto;
  @ApiProperty({
    type: [MonitorMostradorSinClienteDto],
    description: 'F16: pedidos listos sin cliente, ordenados por antigüedad.',
  })
  sinCliente: MonitorMostradorSinClienteDto[];
}
