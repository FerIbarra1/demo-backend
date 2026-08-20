import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { CrearMensajeDto } from './dto/mensaje.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Mensajes')
@Controller('pedidos/:pedidoId/mensajes')
@Roles(
  RolUsuario.CLIENTE,
  RolUsuario.BODEGA,
  RolUsuario.BODEGA_MONITOR,
  RolUsuario.CAJERO,
  RolUsuario.ADMIN,
)
@ApiBearerAuth()
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Listar mensajes del pedido. Cliente sólo ve visibleParaCliente=true. BODEGA/CAJERO/ADMIN ven todos.',
  })
  async listar(@Param('pedidoId', ParseIntPipe) pedidoId: number, @CurrentUser() user: any) {
    return this.service.listar(pedidoId, user);
  }

  @Post()
  @ApiOperation({ summary: 'Crear mensaje. BODEGA/CAJERO/ADMIN pueden crear mensajes internos (visibleParaCliente=false).' })
  async crear(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @Body() dto: CrearMensajeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.crear(pedidoId, dto, user);
  }
}
