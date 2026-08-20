import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { ClienteService } from './cliente.service';
import { CreatePedidoDto } from './dto/create-pedido.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Cliente')
@Controller('cliente/pedidos')
@Roles(RolUsuario.CLIENTE, RolUsuario.ADMIN)
@ApiBearerAuth()
export class ClienteController {
  constructor(private readonly clienteService: ClienteService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un nuevo pedido (estado inicial: PENDING_REVIEW)' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'UUID opcional para evitar duplicados' })
  @ApiHeader({ name: 'X-Tienda-Id', required: false, description: 'Tienda activa del cliente (override de la tienda del usuario)' })
  @ApiHeader({ name: 'X-Kiosko-Id', required: false, description: 'ID del kiosko si el pedido se origina en una tablet de tienda (fuerza canalOrigen=KIOSKO)' })
  async crearPedido(
    @Body() dto: CreatePedidoDto,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-tienda-id') tiendaIdHeader?: string,
    @Headers('x-kiosko-id') kioskoIdHeader?: string,
  ) {
    const tiendaIdHeaderNum = tiendaIdHeader ? parseInt(tiendaIdHeader, 10) : undefined;
    const kioskoIdHeaderNum = kioskoIdHeader ? parseInt(kioskoIdHeader, 10) : undefined;
    return this.clienteService.crearPedido(
      dto,
      { ...user, tiendaIdHeader: tiendaIdHeaderNum },
      idempotencyKey,
      Number.isFinite(kioskoIdHeaderNum) ? kioskoIdHeaderNum : undefined,
    );
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
    return this.clienteService.obtenerMisPedidos(
      userId,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 10,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de mi pedido (mensajes, historial)' })
  async obtenerMiPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('userId') userId: number,
  ) {
    return this.clienteService.obtenerMiPedido(id, userId);
  }

  @Post(':id/cancelar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar mi pedido (sólo antes de PAID)' })
  async cancelarPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.clienteService.cancelarPedido(id, user.userId, user);
  }
}
