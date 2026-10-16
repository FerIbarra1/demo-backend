import { ApiProperty } from '@nestjs/swagger';

/**
 * F16 (sep 2026): snapshot del monitor de mostrador — la TV de la pared.
 *
 * Oct 2026 (16-oct): REDUCIDO A FOLIO + NÚMEROS. La pantalla es PÚBLICA y este payload viaja hasta
 * el navegador de la pared, aunque la TV no pinte todo lo que recibe. Antes cada pedido traía
 * nombre del cliente, total, canal, número de productos, fechas, tiempos de espera y el nombre del
 * operador, y la respuesta traía además la lista de "pedidos sin recoger" con nombres: nada de eso
 * se ve en la TV, pero cualquiera que abriera la pestaña de red lo leía. Ahora solo sale lo que la
 * pantalla dibuja: el folio, a qué mostrador pasar, y el operador de cada puesto (personal, no
 * cliente). Lo que la consola del operador necesita (nombres, montos, canal) vive en sus propios
 * endpoints, que sí están autenticados con un rol de empleado.
 *
 * Es una pantalla "estilo banco" por PUESTOS (como la TV de caja): una tarjeta por mostrador con el
 * folio que atiende, y la cola de espera. No hay urgencia ni tiempo de espera (decisión D13): en
 * mostrador el pedido espera al CLIENTE, no al revés.
 */

/** Un folio en la TV. Nada más: ni nombre, ni canal, ni monto. */
export class MonitorMostradorPedidoDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Número del mostrador al que pasa el cliente. Solo en los ya llamados; null en la cola.',
  })
  mostradorNumero: number | null;
}

export class MonitorMostradorContadoresDto {
  @ApiProperty({ description: 'Pedidos en la cola de mostrador' })
  enCola: number;
  @ApiProperty({ description: 'Pedidos que el operador ya mandó a llamar' })
  atendiendo: number;
}

/**
 * Oct 2026: UN mostrador (puesto) de la TV, como las ventanillas de la TV de caja: número, quién
 * lo atiende y los folios que tiene llamados ahora.
 */
export class MonitorMostradorPuestoDto {
  @ApiProperty() mostradorId: number;
  @ApiProperty() numero: number;
  @ApiProperty({ nullable: true, type: String }) operadorNombre: string | null;
  @ApiProperty({
    description:
      'Hay un operador con señales de vida en los últimos 15 min. Falso = la TV lo pinta "Cerrado": el cliente no debe caminar a un mostrador sin nadie.',
  })
  abierto: boolean;
  @ApiProperty({ type: [MonitorMostradorPedidoDto] })
  atendiendo: MonitorMostradorPedidoDto[];
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
      'Todos los ya llamados, del más reciente al más viejo (el mismo contenido que `mostradores` y ' +
      '`sinMostrador` juntos; se conserva para una TV con la versión anterior de la pantalla).',
  })
  atendiendo: MonitorMostradorPedidoDto[];
  @ApiProperty({
    type: [MonitorMostradorPuestoDto],
    description: 'Los mostradores de la tienda con lo que atiende cada uno (como la TV de caja).',
  })
  mostradores: MonitorMostradorPuestoDto[];
  @ApiProperty({
    type: [MonitorMostradorPedidoDto],
    description:
      'Llamados sin un mostrador válido (datos anteriores a los puestos, o mostrador borrado): no deben desaparecer de la TV.',
  })
  sinMostrador: MonitorMostradorPedidoDto[];
  @ApiProperty({ type: MonitorMostradorContadoresDto })
  contadores: MonitorMostradorContadoresDto;
}
