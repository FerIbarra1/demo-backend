import { Controller, Get, Post, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Mostrador')
@Controller('pedidos/mostrador')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidosMostradorController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get('listos')
  @ApiOperation({ summary: 'Obtener pedidos listos para entrega' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  async obtenerListos(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
  ) {
    return this.pedidosService.obtenerPedidosListos(
      tiendaId ? parseInt(tiendaId, 10) : user.tiendaId,
    );
  }

  @Get('buscar')
  @ApiOperation({ summary: 'Buscar pedido por número' })
  async buscarPedido(
    @Query('numero') numeroPedido: string,
  ) {
    return this.pedidosService.buscarPedidoPorNumero(numeroPedido);
  }

  @Post(':id/entregar')
  @ApiOperation({ summary: 'Entregar pedido al cliente' })
  async entregarPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.entregarPedido(id, user);
  }
}
