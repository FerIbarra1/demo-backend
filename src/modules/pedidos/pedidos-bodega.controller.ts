import { Controller, Get, Post, Param, Query, ParseIntPipe, UseGuards, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { UpdatePedidoDto } from './dto/update-pedido.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario, EstadoPedido } from '@prisma/client';

@ApiTags('Pedidos - Bodega')
@Controller('pedidos/bodega')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.BODEGA, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidosBodegaController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get('pendientes')
  @ApiOperation({ summary: 'Obtener pedidos pendientes en bodega' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  async obtenerPedidosBodega(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
  ) {
    return this.pedidosService.obtenerPedidosBodega(
      tiendaId ? parseInt(tiendaId, 10) : user.tiendaId,
    );
  }

  @Get(':id/verificar-stock')
  @ApiOperation({ summary: 'Verificar disponibilidad de stock' })
  async verificarStock(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.verificarStockPedido(id, user);
  }

  @Post(':id/en-bodega')
  @ApiOperation({ summary: 'Marcar pedido como recibido en bodega' })
  async marcarEnBodega(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.marcarEnBodega(id, user);
  }

  @Post(':id/listo')
  @ApiOperation({ summary: 'Marcar pedido como listo para entrega' })
  async marcarListo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.marcarListoParaEntrega(id, user);
  }

  @Post(':id/notas')
  @ApiOperation({ summary: 'Actualizar notas de bodega' })
  async actualizarNotas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.actualizarNotasBodega(id, dto.notasBodega || '', user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener pedido completo' })
  async obtenerPedido(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.pedidosService.obtenerPedidoCompleto(id);
  }
}
