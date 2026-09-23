import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PropuestaService } from './propuesta.service';
import { CrearPropuestaDto, ResponderPropuestaDto } from './dto/propuesta.dto';
import { MessagesService } from '../messages/messages.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F12/F13 (sep 2026): endpoints del flujo de propuesta/contrapropuesta.
 *
 * - Bodega envía propuesta:  `POST /bodega/pedidos/:id/propuesta`
 * - Ventas envía propuesta:  `POST /ventas/pedidos/:id/propuesta`
 * - Cliente responde:        `POST /cliente/pedidos/:id/propuesta/:propuestaId/respuesta`
 * - Admin fuerza:            `POST /admin/pedidos/:id/propuesta/:propuestaId/forzar`
 * - Listar (cualquier rol autorizado): `GET /pedidos/:id/propuestas`
 *
 * El envío de ventas comparte el mismo service que el de bodega: la diferencia
 * (qué estados acepta, si exige asignación) se decide por el ROL del usuario.
 *
 * F14 (sep 2026): el endpoint de BODEGA delega a `MessagesService.crearConAdjunto`
 * para crear la propuesta Y el mensaje de chat con adjunto en la misma
 * transacción. Sin esto, la propuesta se creaba en BD pero el cliente no veía
 * nada en el chat — sólo el badge "Esperando tu aprobación" sin propuesta
 * visible. El flujo de ventas sigue usando `useMensajeConAdjunto` desde el
 * frontend, así que ese endpoint queda como está.
 */
@ApiTags('Pedidos - Propuestas')
@ApiBearerAuth()
@Controller()
export class PropuestaController {
  constructor(
    private readonly propuestaService: PropuestaService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post('bodega/pedidos/:id/propuesta')
  @Roles(RolUsuario.BODEGA, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Bodega envía una propuesta (hay faltantes). Crea la PedidoPropuesta Y el ' +
      'PedidoMensaje con adjunto en la misma transacción. El pedido pasa a ' +
      'WAITING_CUSTOMER_APPROVAL, libera el slot del bodeguero y detiene el reloj de atención.',
  })
  async enviarPropuesta(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CrearPropuestaDto,
    @CurrentUser() user: any,
  ) {
    // El mensaje-con-adjunto es la fuente de verdad del chat del cliente;
    // delegamos ahí para que ambos (propuesta + mensaje) queden consistentes.
    const nota = dto.nota?.trim() || 'Te propongo estos ajustes.';
    const resultado = await this.messagesService.crearConAdjunto(
      id,
      {
        contenido: nota,
        propuestaItems: dto.items.map((it) => ({
          itemId: it.itemId,
          // El DTO de entrada usa string (ClassValidator); el de adjunto
          // exige el union literal. Cast explícito: ya validamos arriba.
          tipo: it.tipo as
            | 'completo'
            | 'cambio'
            | 'no-disponible'
            | 'parcial'
            | 'agregado',
          producto: it.producto,
          variante: it.variante,
          cantidad: it.cantidad,
          precioUnitario: it.precioUnitario,
          subtotal: it.subtotal,
          cantidadNueva: it.cantidadNueva,
          subtotalNuevo: it.subtotalNuevo,
          precioCOId: it.precioCOId,
        })),
        total: dto.total ?? 0,
      },
      user,
    );
    // `resultado` es el mensaje creado (la propuesta viene como adjunto). El
    // frontend igual consume el adjunto por separado vía `propuesta-adjunto`.
    return resultado;
  }

  @Post('ventas/pedidos/:id/propuesta')
  @Roles(RolUsuario.VENTAS, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'El asesor de ventas envía una contrapropuesta al cliente (productos, cantidades o variantes distintas). El pedido debe estar EN_ASESORIA o re-negociando.',
  })
  async enviarPropuestaVentas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CrearPropuestaDto,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.enviarPropuesta(id, dto, user);
  }

  @Post('cliente/pedidos/:id/propuesta/:propuestaId/respuesta')
  @Roles(RolUsuario.CLIENTE, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Cliente responde a una propuesta. Las decisiones legales dependen del origen: ' +
      'propuesta de bodega admite APROBAR/RECHAZAR/CONTACTAR_ASESOR; ' +
      'propuesta de ventas admite APROBAR/RECHAZAR/CANCELAR_PEDIDO.',
  })
  async responderPropuesta(
    @Param('id', ParseIntPipe) id: number,
    @Param('propuestaId', ParseIntPipe) propuestaId: number,
    @Body() dto: ResponderPropuestaDto,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.responderPropuesta(id, propuestaId, dto, user);
  }

  @Post('admin/pedidos/:id/propuesta/:propuestaId/forzar')
  @Roles(RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Admin fuerza la aprobación de una propuesta sin respuesta del cliente (caso excepcional). Registra auditoría.',
  })
  async forzarAprobacion(
    @Param('id', ParseIntPipe) id: number,
    @Param('propuestaId', ParseIntPipe) propuestaId: number,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.forzarAprobacion(id, propuestaId, user);
  }

  @Get('pedidos/:id/propuestas')
  @Roles(RolUsuario.BODEGA, RolUsuario.VENTAS, RolUsuario.ADMIN, RolUsuario.CLIENTE)
  @ApiOperation({ summary: 'Lista las propuestas de un pedido (historial).' })
  async listarPropuestas(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.listarPropuestas(id, user);
  }
}
