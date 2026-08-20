import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { BodegaService } from './bodega.service';
import { SurtidoService } from './surtido.service';
import { PedidoStateService } from '../core/pedido-state.service';
import { MarcarSurtidoItemDto } from './dto/surtido.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario, EstadoPedido } from '@prisma/client';

@ApiTags('Pedidos - Bodega')
@Controller('bodega/pedidos')
@Roles(RolUsuario.BODEGA, RolUsuario.ADMIN)
@ApiBearerAuth()
export class BodegaController {
  constructor(
    private readonly bodegaService: BodegaService,
    private readonly surtidoService: SurtidoService,
    private readonly pedidoState: PedidoStateService,
  ) {}

  @Get('pendientes')
  @ApiOperation({ summary: 'Obtener pedidos pendientes para bodega' })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'estado', required: false, enum: EstadoPedido })
  @ApiQuery({
    name: 'estados',
    required: false,
    type: String,
    description:
      'CSV de estados. F7: el filtro "Pendientes y liberados" manda "PENDING_REVIEW,REVIEWING" + soloLibres=true',
  })
  @ApiQuery({
    name: 'soloLibres',
    required: false,
    type: Boolean,
    description:
      'F7: si true, filtra a pedidos sin asignar (asignadoAId=null). Se usa con estados=REVIEWING para "liberados".',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async obtenerPendientes(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('estado') estado?: EstadoPedido,
    @Query('estados') estadosCsv?: string,
    @Query('soloLibres') soloLibres?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    const estados = estadosCsv
      ? (estadosCsv.split(',').map((s) => s.trim()) as EstadoPedido[])
      : undefined;
    return this.bodegaService.obtenerPedidosBodega(
      tiendaId ? parseInt(tiendaId, 10) : user.tiendaId,
      estado,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      estados,
      soloLibres === 'true' || soloLibres === '1',
    );
  }

  @Get('mis-pedidos')
  @ApiOperation({ summary: 'Pedidos asignados al bodeguero autenticado y en proceso' })
  async misPedidos(@CurrentUser() user: any) {
    return this.bodegaService.obtenerMisPedidosBodeguero(
      user.userId,
      user.tiendaId,
      this.surtidoService.maxPedidosPorBodeguero,
    );
  }

  @Get('surtir-juntos')
  @ApiOperation({
    summary:
      'Pedidos en cola con items compartidos con los del bodeguero autenticado. ' +
      'Top 10, score = 10/precioCO + 4/producto + 1/minuto antigüedad.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array (puede ser vacío). Cada elemento trae los items compartidos con detalle.',
  })
  async surtirJuntos(@CurrentUser() user: any) {
    return this.bodegaService.obtenerSurtirJuntos(user.userId, user.tiendaId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener pedido completo (items, revisiones, mensajes)' })
  async obtenerPedido(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.pedidoState.obtenerDetalle(id, user);
  }

  @Post(':id/tomar')
  @ApiOperation({
    summary:
      'PENDING_REVIEW → REVIEWING, o REVIEWING libre → REVIEWING asignado (caso liberado). En ambos casos asigna el pedido al bodeguero autenticado.',
  })
  async tomar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    if (user.rol === RolUsuario.BODEGA_MONITOR) {
      throw new BadRequestException(
        'Tu rol es de monitor. No puedes tomar pedidos. Usa la tablet con un usuario BODEGA.',
      );
    }
    if (user.rol !== RolUsuario.ADMIN) {
      const puedeTomar = await this.surtidoService.puedeTomarOtro(user.userId);
      if (!puedeTomar) {
        throw new BadRequestException(
          `Has alcanzado el máximo de ${this.surtidoService.maxPedidosPorBodeguero} pedidos simultáneos. Finaliza o libera alguno antes de tomar otro.`,
        );
      }
    }
    return this.bodegaService.tomarPedido(id, user);
  }

  @Post(':id/liberar')
  @ApiOperation({
    summary:
      'Liberar pedido tomado (asignadoAId=null, estado sigue REVIEWING). Otro bodeguero puede retomarlo desde /bodega.',
  })
  async liberar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.bodegaService.liberarPedido(id, user);
  }

  @Post(':id/marcar-enviado')
  @ApiOperation({
    summary:
      'PAID → SHIPPED. Sólo aplica a pedidos a domicilio (con shippingDireccion). Kiosko/web-recoger van al módulo Mostrador para entrega directa (PAID → COMPLETED).',
  })
  async marcarEnviado(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.bodegaService.marcarEnviado(id, user);
  }

  @Get(':id/surtir')
  @ApiOperation({ summary: 'Detalle del pedido con items y su estado de surtido' })
  async surtirDetalle(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    const esAdmin = user.rol === RolUsuario.ADMIN;
    return this.surtidoService.obtenerDetalle(id, user, esAdmin);
  }

  @Post(':id/items/:itemId/surtido')
  @ApiOperation({ summary: 'Marcar cantidad surtida + estado de un item' })
  async marcarItemSurtido(
    @Param('id', ParseIntPipe) pedidoId: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: MarcarSurtidoItemDto,
    @CurrentUser() user: any,
  ) {
    const esAdmin = user.rol === RolUsuario.ADMIN;
    return this.surtidoService.marcarItem(pedidoId, itemId, dto, user, esAdmin);
  }

  @Post(':id/confirmar-surtido')
  @ApiOperation({
    summary:
      'Cerrar surtido. Aplica los cambios (cancela NO_DISPONIBLES, ajusta cantidades, crea sustituciones) y pasa el pedido a APPROVED. La negociación con el cliente ocurre por chat.',
  })
  async confirmarSurtido(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    const esAdmin = user.rol === RolUsuario.ADMIN;
    return this.surtidoService.confirmarSurtido(id, user, esAdmin);
  }

  /**
   * F10 (ago 2026): pedidos en cola que comparten items con los que el
   * bodeguero tiene asignados. Alimenta el banner "Surtir juntos" en
   * /bodega para sugerir qué pedidos conviene tomar a continuación.
   *
   * Mismo algoritmo de scoring que `calcularSimilaresParaPedido` del
   * surtido.service.ts y que el monitor, centralizado en
   * `core/similitud.util.ts`.
   *
   * NOTA: la ruta fija `surtir-juntos` está declarada arriba de @Get(':id')
   * para que NestJS la matchee antes que el parámetro dinámico — si no,
   * ParseIntPipe falla con "numeric string is expected" sobre la cadena
   * literal "surtir-juntos".
   */
}
