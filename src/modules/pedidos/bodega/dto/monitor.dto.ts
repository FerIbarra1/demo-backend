import { ApiProperty } from '@nestjs/swagger';
import { EstadoPedido, CanalOrigen } from '@prisma/client';

export class MonitorPedidoDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty({ enum: EstadoPedido }) estado: EstadoPedido;
  @ApiProperty({ enum: CanalOrigen }) canalOrigen: CanalOrigen;
  @ApiProperty() clienteNombre: string;
  @ApiProperty() total: number;
  @ApiProperty() itemsCount: number;
  @ApiProperty() fechaPedido: string;
  @ApiProperty({ nullable: true, type: String })
  fechaAsignacion: string | null;
  @ApiProperty({ description: 'Minutos desde que se creó el pedido (o se asignó, si está REVIEWING)' })
  minutosEnCola: number;
  @ApiProperty({ description: '0=normal, 1=aviso, 2=alerta, 3=crítico' })
  nivelUrgencia: number;
  @ApiProperty({ nullable: true, type: String })
  asignadoAId: number | null;
  @ApiProperty({ nullable: true, type: String })
  asignadoANombre: string | null;
  // Cajero (monitor de ventanillas): sólo aplica a pedidos KIOSKO en PENDING_PAID.
  @ApiProperty({ nullable: true, type: String })
  cajeroAsignadoId: number | null;
  @ApiProperty({ nullable: true, type: String })
  cajeroAsignadoAt: string | null;
  @ApiProperty({ nullable: true, type: String })
  cajeroAsignadoNombre: string | null;
  /** true si el bodeguero del equipo lo tendría como sugerido (mismos items que ya surte) */
  @ApiProperty({ default: false })
  sugerido: boolean;
  /** Score de similitud (mayor = más relevante). 0 si no hay match. */
  @ApiProperty({ default: 0 })
  scoreSimilitud: number;
  /** Número de items del pedido que matchean con lo que un bodeguero ya está surtiendo */
  @ApiProperty({ default: 0 })
  itemsCompartidos: number;
  /**
   * F6 (jul 2026): true si el pedido está en REVIEWING sin asignado
   * (otro bodeguero lo liberó). El monitor lo destaca con badge "LIBRE"
   * y leve pulse para que quien mira la TV identifique que está disponible
   * para tomar.
   */
  @ApiProperty({ default: false })
  esLiberado: boolean;
}

/**
 * F6 (jul 2026): un slot de pedido en curso para un bodeguero del equipo.
 * El bodeguero puede tener entre 0 y MAX_PEDIDOS_POR_BODEGUERO pedidos
 * simultáneos. El monitor los renderiza como slots visibles.
 */
export class MonitorBodegueroPedidoSlotDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty({ enum: EstadoPedido }) estado: EstadoPedido;
  @ApiProperty({ description: 'Timestamp ISO del momento en que tomó este pedido' })
  asignadoAt: string;
  @ApiProperty({ description: 'Minutos desde que tomó este pedido' })
  minutosEnProceso: number;
  @ApiProperty({ description: '0=normal, 1=aviso, 2=alerta, 3=crítico' })
  nivelUrgencia: 0 | 1 | 2 | 3;
}

export class MonitorBodegueroDto {
  @ApiProperty() id: number;
  @ApiProperty() nombre: string;
  @ApiProperty({ nullable: true }) apellido: string | null;
  @ApiProperty() activo: boolean;
  @ApiProperty({ nullable: true, type: String }) lastLogin: string | null;
  /**
   * F6 (jul 2026): hasta MAX_PEDIDOS_POR_BODEGUERO pedidos en curso. El
   * frontend renderiza cada uno como un slot. Si está vacío, el bodeguero
   * está libre y puede tomar un pedido nuevo.
   */
  @ApiProperty({ type: [MonitorBodegueroPedidoSlotDto] })
  pedidosActuales: MonitorBodegueroPedidoSlotDto[];
  /** Máximo permitido de pedidos simultáneos (referencia para la UI). */
  @ApiProperty({ description: 'Tope de pedidos simultáneos para este bodeguero' })
  maxPedidos: number;
  @ApiProperty() ultimaActividad: string;
}

export class MonitorContadoresDto {
  @ApiProperty() pedidosEnTienda: number;
  @ApiProperty() pedidosWeb: number;
  @ApiProperty() alertasCriticas: number;
  @ApiProperty() bodeguerosLibres: number;
  @ApiProperty() bodeguerosOcupados: number;
  @ApiProperty() totalEnCola: number;
}

export class MonitorResponseDto {
  @ApiProperty() timestamp: string;
  @ApiProperty() tiendaId: number;
  @ApiProperty() tiendaNombre: string;
  @ApiProperty({ type: [MonitorBodegueroDto] })
  equipo: MonitorBodegueroDto[];
  @ApiProperty({ type: MonitorContadoresDto })
  contadores: MonitorContadoresDto;
  @ApiProperty({ type: [MonitorPedidoDto] })
  pedidosTienda: MonitorPedidoDto[];
  @ApiProperty({ type: [MonitorPedidoDto] })
  pedidosWeb: MonitorPedidoDto[];
}

// ============================================
// Monitor de Cajero (jun 2026)
// ============================================

export class MonitorPedidoCajeroDto {
  @ApiProperty() id: number;
  @ApiProperty() numeroPedido: string;
  @ApiProperty() clienteNombre: string;
  @ApiProperty() total: number;
  @ApiProperty() itemsCount: number;
  @ApiProperty() fechaPedido: string;
  @ApiProperty({ nullable: true, type: String })
  cajeroAsignadoAt: string | null;
  @ApiProperty({ description: 'Minutos desde que se aprobó (entró a PENDING_PAID)' })
  minutosEnCola: number;
}

export class MonitorCajeroVentanillaDto {
  @ApiProperty() id: number;
  @ApiProperty() nombre: string;
  @ApiProperty({ nullable: true }) apellido: string | null;
  @ApiProperty({ description: 'Timestamp ISO del lastLogin. La cajero aparece sólo si está activo y logueado.' })
  lastLogin: string | null;
  @ApiProperty() pedidosAsignados: number;
  @ApiProperty({ type: [MonitorPedidoCajeroDto] })
  detallePedidos: MonitorPedidoCajeroDto[];
}

export class MonitorCajeroContadoresDto {
  @ApiProperty() cajerosLogueados: number;
  @ApiProperty() colaSinAsignar: number;
  @ApiProperty() totalEnCaja: number;
  @ApiProperty() alertasCriticas: number;
}

export class MonitorCajeroResponseDto {
  @ApiProperty() timestamp: string;
  @ApiProperty() tiendaId: number;
  @ApiProperty() tiendaNombre: string;
  @ApiProperty({ type: [MonitorCajeroVentanillaDto] })
  ventanillas: MonitorCajeroVentanillaDto[];
  @ApiProperty({ type: MonitorCajeroContadoresDto })
  contadores: MonitorCajeroContadoresDto;
  @ApiProperty({ type: [MonitorPedidoCajeroDto] })
  colaSinAsignar: MonitorPedidoCajeroDto[];
}
