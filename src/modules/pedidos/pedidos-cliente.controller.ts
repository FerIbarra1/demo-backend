import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Cliente')
@Controller('pedidos/cliente')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.CLIENTE, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidosClienteController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un nuevo pedido' })
  async crearPedido(
    @Body() dto: CreatePedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.crearPedido(dto, user);
  }

  @Get('mis-pedidos')
  @ApiOperation({ summary: 'Obtener mis pedidos' })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async obtenerMisPedidos(
    @CurrentUser('userId') userId: number,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    return this.pedidosService.obtenerMisPedidos(
      userId,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 10,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de mi pedido' })
  async obtenerMiPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('userId') userId: number,
  ) {
    return this.pedidosService.obtenerMiPedido(id, userId);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar mi pedido' })
  async cancelarPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.pedidosService.cancelarPedido(id, user.userId, user);
  }
}
