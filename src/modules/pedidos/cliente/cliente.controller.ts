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
  @ApiHeader({ name: 'X-Kiosko-Token', required: false, description: 'Device token del kiosko. OBLIGATORIO si X-Kiosko-Id viene presente (PR2).' })
  async crearPedido(
    @Body() dto: CreatePedidoDto,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-tienda-id') tiendaIdHeader?: string,
    @Headers('x-kiosko-id') kioskoIdHeader?: string,
    @Headers('x-kiosko-token') kioskoDeviceToken?: string,
  ) {
    const tiendaIdHeaderNum = tiendaIdHeader ? parseInt(tiendaIdHeader, 10) : undefined;
    const kioskoIdHeaderNum = kioskoIdHeader ? parseInt(kioskoIdHeader, 10) : undefined;
    return this.clienteService.crearPedido(
      dto,
      { ...user, tiendaIdHeader: tiendaIdHeaderNum },
      idempotencyKey,
      Number.isFinite(kioskoIdHeaderNum) ? kioskoIdHeaderNum : undefined,
      kioskoDeviceToken,
    );
  }

  // PR7 (kiosko-profesional): avisar llegada desde la app/web del
  // cliente. Crea la misma señal de cola que el kiosko pero autenticado
  // por el JWT del dueño del pedido.
  @Post(':id/anunciar-llegada')
  @ApiOperation({
    summary: 'Cliente avisa que llegó a la tienda a recoger su pedido',
  })
  async anunciarLlegada(
    @Param('id', ParseIntPipe) pedidoId: number,
    @CurrentUser('userId') userId: number,
  ) {
    return this.clienteService.anunciarLlegada(pedidoId, userId);
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
