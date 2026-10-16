import { Controller, Get, Post, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CajeroService } from './cajero.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { EstacionGuard, RequiereEstacion } from '../../../common/guards/estacion.guard';

/**
 * Consola del Cajero (jun 2026):
 * - Cola de pedidos en PENDIENTE_PAGO sin asignar a ninguna ventanilla. Desde F16 incluye
 *   KIOSKO y WEB; los pedidos a DOMICILIO no se cobran en ventanilla y no aparecen aquí.
 * - Tomar pedido → asigna `cajeroAsignadoId` (1:1 con el usuario Cajero logueado). Si dos
 *   cajeros lo toman a la vez, uno gana y el otro recibe 409.
 * - Liberar pedido → devuelve el pedido a la cola.
 *
 * El cobro se confirma en un sistema externo (Firebird) que dispara
 * `POST /admin/pedidos/:id/marcar-pagado`. Este controller NO aprueba pagos.
 */
@ApiTags('Pedidos - Cajero')
@UseGuards(EstacionGuard)
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
      'Cola de pedidos en PENDIENTE_PAGO sin asignar (monitor de ventanillas). ' +
      'F16: incluye KIOSKO y WEB por defecto — los pedidos web también se ' +
      'cobran aquí. Pasar canal=KIOSKO para ver solo los de la tienda.',
  })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'pago',
    required: false,
    enum: ['verificado', 'en-proceso'],
    description:
      'Oct 2026. `verificado` = la transferencia llegó y falta registrar el cobro en VFP; `en-proceso` = hay una transferencia abierta, NO cobrar.',
  })
  @ApiQuery({
    name: 'canal',
    required: false,
    enum: ['KIOSKO', 'WEB', 'TODOS'],
    description: 'Filtro por canal. Default: TODOS.',
  })
  async obtenerColaVentanilla(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('canal') canal?: string,
    @Query('pago') pago?: string,
  ) {
    const tiendaSolicitada = tiendaId ? parseInt(tiendaId, 10) : undefined;
    const tiendaEfectiva =
      user.rol === RolUsuario.ADMIN ? (tiendaSolicitada ?? user.tiendaId) : user.tiendaId;
    return this.cajeroService.obtenerColaVentanilla(
      tiendaEfectiva,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      // F16: default 'TODOS' (antes 'KIOSKO', que escondía los pedidos web).
      (canal as 'KIOSKO' | 'WEB' | 'TODOS') ?? 'TODOS',
      pago === 'verificado' || pago === 'en-proceso' ? pago : undefined,
    );
  }

  @Get('mis-pedidos')
  @ApiOperation({
    summary: 'Pedidos en PENDIENTE_PAGO asignados al cajero autenticado',
  })
  async misPedidos(@CurrentUser() user: any) {
    return this.cajeroService.obtenerMisPedidosCajero(user.userId, user.tiendaId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de pedido (sólo validación de tienda)' })
  async obtenerPedido(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.pedidoState.obtenerDetalle(id, user);
  }

  @Post(':id/tomar')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Tomar pedido de la cola → lo asigna a la ventanilla del cajero logueado (409 si otro lo tomó)',
  })
  async tomar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.tomarPedidoCajero(id, user);
  }

  @Post(':id/liberar')
  @RequiereEstacion()
  @ApiOperation({
    summary: 'Liberar pedido → vuelve a la cola de ventanillas',
  })
  async liberar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.liberarPedidoCajero(id, user);
  }

  @Post(':id/no-se-presento')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: el cliente llamado a la ventanilla no se presentó → sale de la ventanilla y ' +
      'pasa al FINAL de la fila (a diferencia de `liberar`, que conserva su lugar).',
  })
  async noSePresento(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.noSePresento(id, user);
  }

  @Post(':id/esperar-validacion')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: regresar a la cola HASTA QUE SE VALIDE la transferencia → sale de la ventanilla ' +
      'conservando su lugar, y "Llamar siguiente" no lo vuelve a llamar mientras siga sin verificar. ' +
      'Solo con una transferencia sin validar (400 si no).',
  })
  async esperarValidacion(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.cajeroService.esperarValidacion(id, user);
  }

  /**
   * F11 (ago 2026): la cajera presiona "Llamar siguiente" → toma el primer
   * pedido de la cola sin asignar y lo asigna a su ventanilla. Si no tiene
   * ventanilla asignada, error 400.
   *
   * Emite realtime `pedido.llamado` para que la TV muestre la alerta.
   */
  @Post('llamar-siguiente')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'F11: llamar al siguiente turno de la cola. Asigna el pedido más antiguo ' +
      'sin asignar a la ventanilla del cajero logueado.',
  })
  async llamarSiguiente(@CurrentUser() user: any) {
    return this.cajeroService.llamarSiguiente(user);
  }
}
