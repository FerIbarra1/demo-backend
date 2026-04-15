import { Controller, Get, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario, EstadoPedido, EstadoPago } from '@prisma/client';

@ApiTags('Pedidos - Admin')
@Controller('pedidos/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidosAdminController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener todos los pedidos con filtros' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'estado', required: false, enum: EstadoPedido })
  @ApiQuery({ name: 'estadoPago', required: false, enum: EstadoPago })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async obtenerTodos(
    @Query('tiendaId') tiendaId?: string,
    @Query('estado') estado?: EstadoPedido,
    @Query('estadoPago') estadoPago?: EstadoPago,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    return this.pedidosService.obtenerTodosPedios({
      tiendaId: tiendaId ? parseInt(tiendaId, 10) : undefined,
      estado,
      estadoPago,
      pagina: pagina ? parseInt(pagina, 10) : 1,
      limite: limite ? parseInt(limite, 10) : 20,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener pedido completo con historial' })
  async obtenerPedidoCompleto(@Param('id', ParseIntPipe) id: number) {
    return this.pedidosService.obtenerPedidoCompleto(id);
  }

  @Get(':id/historial')
  @ApiOperation({ summary: 'Obtener historial de un pedido' })
  async obtenerHistorial(@Param('id', ParseIntPipe) id: number) {
    return this.pedidosService.obtenerHistorialPedido(id);
  }
}
