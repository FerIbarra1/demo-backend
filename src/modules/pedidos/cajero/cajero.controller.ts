import { Controller, Get, Post, Param, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CajeroService } from './cajero.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * Consola del Cajero (jun 2026):
 * - Cola de pedidos KIOSKO en PENDING_PAID sin asignar a ninguna ventanilla.
 * - Tomar pedido → asigna `cajeroAsignadoId` (1:1 con el usuario Cajero logueado).
 * - Liberar pedido → devuelve el pedido a la cola.
 *
 * El cobro se confirma en un sistema externo (Firebird) que dispara
 * `POST /admin/pedidos/:id/marcar-pagado`. Este controller NO aprueba pagos.
 */
@ApiTags('Pedidos - Cajero')
@Controller('cajero/pedidos')
@Roles(RolUsuario.CAJERO, RolUsuario.ADMIN)
@ApiBearerAuth()
export class CajeroController {
  constructor(
    private readonly cajeroService: CajeroService,
    private readonly pedidoState: PedidoStateService,
  ) {}

  @Get('cola-ventanilla')
  @ApiOperation({
    summary:
      'Cola de pedidos en PENDING_PAID sin asignar (monitor de ventanillas). ' +
      'Por defecto sólo KIOSKO; pasar canal=TODOS para incluir WEB.',
  })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'canal',
    required: false,
    enum: ['KIOSKO', 'WEB', 'TODOS'],
    description: 'Filtro por canal. Default: KIOSKO.',
  })
  async obtenerColaVentanilla(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('canal') canal?: string,
  ) {
    const tiendaSolicitada = tiendaId ? parseInt(tiendaId, 10) : undefined;
    const tiendaEfectiva =
      user.rol === RolUsuario.ADMIN
        ? tiendaSolicitada ?? user.tiendaId
        : user.tiendaId;
    return this.cajeroService.obtenerColaVentanilla(
      tiendaEfectiva,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      (canal as 'KIOSKO' | 'WEB' | 'TODOS') ?? 'KIOSKO',
    );
  }

  @Get('mis-pedidos')
  @ApiOperation({
    summary:
      'Pedidos del kiosko en PENDING_PAID asignados al cajero autenticado',
  })
  async misPedidos(@CurrentUser() user: any) {
    return this.cajeroService.obtenerMisPedidosCajero(user.userId, user.tiendaId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de pedido (sólo validación de tienda)' })
  async obtenerPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidoState.obtenerDetalle(id, user);
  }

  @Post(':id/tomar')
  @ApiOperation({
    summary:
      'Tomar pedido del kiosko → lo asigna a la ventanilla del cajero logueado',
  })
  async tomar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.tomarPedidoCajero(id, user);
  }

  @Post(':id/liberar')
  @ApiOperation({
    summary: 'Liberar pedido → vuelve a la cola de ventanillas',
  })
  async liberar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.liberarPedidoCajero(id, user);
  }

  /**
   * F11 (ago 2026): la cajera presiona "Llamar siguiente" → toma el primer
   * pedido de la cola sin asignar y lo asigna a su ventanilla. Si no tiene
   * ventanilla asignada, error 400.
   *
   * Emite realtime `pedido.llamado` para que la TV muestre la alerta.
   */
  @Post('llamar-siguiente')
  @ApiOperation({
    summary:
      'F11: llamar al siguiente turno de la cola. Asigna el pedido más antiguo ' +
      'sin asignar a la ventanilla del cajero logueado.',
  })
  async llamarSiguiente(@CurrentUser() user: any) {
    return this.cajeroService.llamarSiguiente(user);
  }
}
