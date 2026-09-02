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
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F12 (sep 2026): endpoints del flujo de propuesta/contrapropuesta.
 *
 * - Bodega envía propuesta: `POST /bodega/pedidos/:id/propuesta`
 * - Cliente responde:      `POST /cliente/pedidos/:id/propuesta/:propuestaId/respuesta`
 * - Admin fuerza:          `POST /admin/pedidos/:id/propuesta/:propuestaId/forzar`
 * - Listar (cualquier rol autorizado): `GET /pedidos/:id/propuestas`
 */
@ApiTags('Pedidos - Propuestas')
@ApiBearerAuth()
@Controller()
export class PropuestaController {
  constructor(private readonly propuestaService: PropuestaService) {}

  @Post('bodega/pedidos/:id/propuesta')
  @Roles(RolUsuario.BODEGA, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Bodega envía una propuesta de ajuste al cliente (hay faltantes). El pedido pasa a WAITING_CUSTOMER_APPROVAL y el reloj de atención se pausa.',
  })
  async enviarPropuesta(
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
      'Cliente responde a una propuesta: ACEPTAR (aplica cambios y libera a PENDING_PAID) o RECHAZAR (vuelve a REVIEWING).',
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
  @Roles(RolUsuario.BODEGA, RolUsuario.ADMIN, RolUsuario.CLIENTE)
  @ApiOperation({ summary: 'Lista las propuestas de un pedido (historial).' })
  async listarPropuestas(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.listarPropuestas(id, user);
  }
}
