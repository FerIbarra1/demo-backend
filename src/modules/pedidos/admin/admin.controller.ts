import { Controller, Get, Post, Delete, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { ApiKeyAuth } from '../../../common/decorators/api-key.decorator';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario, EstadoPedido } from '@prisma/client';

@ApiTags('Pedidos - Admin')
@Controller('admin/pedidos')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener todos los pedidos con filtros' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'estado', required: false, enum: EstadoPedido })
  @ApiQuery({ name: 'fechaInicio', required: false, type: String, example: '2026-01-01' })
  @ApiQuery({ name: 'fechaFin', required: false, type: String, example: '2026-12-31' })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async obtenerTodos(
    @Query('tiendaId') tiendaId?: string,
    @Query('estado') estado?: EstadoPedido,
    @Query('fechaInicio') fechaInicio?: string,
    @Query('fechaFin') fechaFin?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    return this.adminService.obtenerTodosPedidos({
      tiendaId: tiendaId ? parseInt(tiendaId, 10) : undefined,
      estado,
      fechaInicio: fechaInicio ? new Date(fechaInicio) : undefined,
      fechaFin: fechaFin ? new Date(fechaFin) : undefined,
      pagina: pagina ? parseInt(pagina, 10) : 1,
      limite: limite ? parseInt(limite, 10) : 20,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener pedido completo con historial, revisiones y mensajes' })
  async obtenerPedidoCompleto(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.adminService.obtenerDetalle(id, user);
  }

  @Get(':id/historial')
  @ApiOperation({ summary: 'Obtener historial de cambios de estado' })
  async obtenerHistorial(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.adminService.obtenerHistorialPedido(id, user);
  }

  /**
   * Webhook para que el sistema externo (Firebird) marque un pedido como pagado.
   * Autenticado por header `X-Agent-Key` contra `process.env.AGENT_API_KEY`.
   * También accesible manualmente por ADMIN (vía JWT) como herramienta de soporte.
   *
   * Body esperado: { fechaPago?: string (ISO), referencia?: string }
   */
  @Post(':id/marcar-pagado')
  @UseGuards(ApiKeyGuard)
  @ApiKeyAuth()
  @ApiOperation({
    summary:
      'Webhook del sistema externo (Firebird): PENDING_PAID → PAID. Auth X-Agent-Key.',
  })
  async marcarPagado(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { fechaPago?: string; referencia?: string },
    @CurrentUser() user: any,
  ) {
    return this.adminService.marcarComoPagado(id, body, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar pedido cancelado (limpieza)' })
  async eliminar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.adminService.eliminarPedidoCancelado(id, user);
  }
}
