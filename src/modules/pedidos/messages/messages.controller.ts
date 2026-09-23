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
import { CrearMensajeDto, CrearMensajeConAdjuntoDto, MarcarLeidoDto } from './dto/mensaje.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F13 (sep 2026): el chat con el cliente es del asesor de ventas. BODEGA sale
 * de la lista (perdió el acceso por completo) y VENTAS entra. BODEGA_MONITOR y
 * CAJERO se mantienen como lectura para el monitor y las notas de ventanilla.
 */
@ApiTags('Pedidos - Mensajes')
@Controller('pedidos/:pedidoId/mensajes')
@Roles(
  RolUsuario.CLIENTE,
  RolUsuario.VENTAS,
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
      'Listar mensajes del pedido. Cliente sólo ve visibleParaCliente=true. VENTAS/CAJERO/ADMIN ven todos.',
  })
  async listar(@Param('pedidoId', ParseIntPipe) pedidoId: number, @CurrentUser() user: any) {
    return this.service.listar(pedidoId, user);
  }

  @Post()
  @ApiOperation({
    summary:
      'Crear mensaje. VENTAS/CAJERO/ADMIN pueden crear mensajes internos (visibleParaCliente=false).',
  })
  async crear(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @Body() dto: CrearMensajeDto,
    @CurrentUser() user: any,
  ) {
    return this.service.crear(pedidoId, dto, user);
  }

  @Post('con-adjunto')
  @ApiOperation({
    summary:
      'F13: crear un mensaje de chat que opcionalmente adjunta una propuesta. ' +
      'Si `propuestaItems` viene, se crea la PedidoPropuesta y el PedidoMensaje ' +
      'en la misma transacción; el mensaje lleva `adjunto = { tipo: "propuesta", propuestaId }`. ' +
      'El cliente ve texto + propuesta como una unidad (WhatsApp/Airbnb).',
  })
  async crearConAdjunto(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @Body() dto: CrearMensajeConAdjuntoDto,
    @CurrentUser() user: any,
  ) {
    return this.service.crearConAdjunto(pedidoId, dto, user);
  }

  /**
   * F15: marca de agua de lectura del chat (modelo WhatsApp/Telegram).
   *
   * El cliente lo llama al abrir el detalle del pedido con foco, y el lado tienda
   * (VENTAS/ADMIN/CAJERO) cuando un operador abre el detalle. Es idempotente:
   * nunca decrementa el watermark (sólo lo avanza si el nuevo id es mayor).
   *
   * El backend emite `mensaje.leido` a `pedido-{id}` y a `user-{clienteId}`
   * para que el otro lado vea los ticks ✓✓ actualizarse en tiempo real.
   */
  @Post('leido')
  @ApiOperation({
    summary:
      'Avanzar la marca de agua de lectura del chat del lado del caller. ' +
      'Idempotente: nunca decrementa, sólo avanza si el nuevo id es mayor.',
  })
  async marcarLeido(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @Body() dto: MarcarLeidoDto,
    @CurrentUser() user: any,
  ) {
    return this.service.marcarLeido(pedidoId, dto, user);
  }
}
