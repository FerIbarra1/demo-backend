import { Controller, Get, Post, Param, Query, ParseIntPipe, UseGuards, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { VerificarPagoDto } from './dto/verificar-pago.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Cajero')
@Controller('pedidos/cajero')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.CAJERO, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidosCajeroController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Get('pendientes-pago')
  @ApiOperation({ summary: 'Obtener pedidos pendientes de pago' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  async obtenerPendientesPago(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
  ) {
    return this.pedidosService.obtenerPedidosPendientesPago(
      tiendaId ? parseInt(tiendaId, 10) : user.tiendaId,
    );
  }

  @Post(':id/verificar-pago')
  @ApiOperation({ summary: 'Verificar pago por transferencia/deposito' })
  async verificarPago(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerificarPagoDto,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.verificarPago(id, dto, user);
  }

  @Post(':id/marcar-pagado')
  @ApiOperation({ summary: 'Marcar pedido como pagado en tienda' })
  async marcarPagado(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.marcarPagadoEnTienda(id, user);
  }
}
