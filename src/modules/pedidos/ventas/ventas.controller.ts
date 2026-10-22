import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { VentasService, FILTROS_COLA, FiltroCola } from './ventas.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { DevolverABodegaDto } from './dto/devolver-a-bodega.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import {
  ApiTiendaConsola,
  TiendaConsola,
  TiendaConsolaGuard,
} from '../../../common/tienda-consola';
import { RolUsuario } from '@prisma/client';

/**
 * F13 (sep 2026): consola del asesor de ventas.
 *
 * Un asesor por tienda, sin asignación 1:1. Ve la cola de pedidos que los
 * clientes escalaron desde una propuesta de bodega y negocia por chat.
 *
 * El envío de la contrapropuesta NO vive aquí: usa
 * `POST /bodega/pedidos/:id/propuesta` (PropuestaService), que acepta el rol
 * VENTAS y valida que el pedido esté en EN_ASESORIA o re-negociando.
 */
@ApiTags('Pedidos - Ventas')
@UseGuards(TiendaConsolaGuard)
@Controller('ventas/pedidos')
@Roles(RolUsuario.VENTAS, RolUsuario.ADMIN)
@ApiBearerAuth()
export class VentasController {
  constructor(
    private readonly ventasService: VentasService,
    private readonly pedidoState: PedidoStateService,
  ) {}

  @Get('cola')
  @ApiOperation({
    summary:
      'Cola de pedidos escalados a asesoría en la tienda del asesor. ' +
      'Incluye los recién escalados y los que esperan respuesta del cliente.',
  })
  @ApiTiendaConsola()
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'filtro',
    required: false,
    enum: FILTROS_COLA,
    description:
      'todos (default) | atender (turno del asesor) | esperando (turno del ' +
      'cliente) | respondidos (el cliente rechazó una propuesta de ventas).',
  })
  async cola(
    @TiendaConsola() tiendaId: number,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('filtro') filtro?: string,
  ) {
    const filtroValido = FILTROS_COLA.includes(filtro as FiltroCola)
      ? (filtro as FiltroCola)
      : 'todos';
    return this.ventasService.obtenerCola(
      tiendaId,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      filtroValido,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle del pedido con items, historial y propuestas (para negociar)',
  })
  async detalle(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    // Valida acceso (tienda) reutilizando el access service compartido: un empleado solo ve pedidos de
    // su tienda y el ADMIN, de cualquiera. Oct 2026: ya no se vuelve a comparar con `user.tiendaId` aquí;
    // era una segunda copia de esa regla (redundante, y el contrato de la tienda de consola la prohíbe).
    await this.pedidoState.obtenerDetalle(id, user);
    return this.ventasService.obtenerDetalle(id);
  }

  @Post(':id/devolver-a-bodega')
  @ApiOperation({
    summary:
      'Oct 2026: EN_ASESORIA → EN_REVISION. El asesor revisó el pedido y no hay ' +
      'nada que negociar: vuelve a bodega a surtirse tal cual.',
  })
  async devolverABodega(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DevolverABodegaDto,
    @CurrentUser() user: any,
  ) {
    return this.ventasService.devolverABodega(id, user, dto.nota);
  }
}
