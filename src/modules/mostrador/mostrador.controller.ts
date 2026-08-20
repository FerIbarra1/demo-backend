import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MostradorService } from './mostrador.service';
import { BuscarPedidoDto } from './dto/buscar-pedido.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * Consola del Mostrador (jul 2026).
 *
 * El mostrador es la última parada del pedido antes de que el cliente se
 * lo lleve. Ve la cola de pedidos ya pagados (PAID) o ya enviados (SHIPPED)
 * de su tienda, abre el detalle para confirmar pieza por pieza, y marca
 * como entregado (→ COMPLETED).
 *
 * A diferencia del cajero, NO hay asignación 1:1: cualquier MOSTRADOR de
 * la tienda puede entregar cualquier pedido. Esto es intencional para
 * minimizar la fricción operativa (el cliente llega y el primer mostrador
 * libre lo atiende).
 *
 * Diseño end-to-end:
 *   - Tablet dedicada en tienda (no navega el cliente).
 *   - Lista de pedidos + búsqueda por número o nombre.
 *   - Pantalla de detalle con checklist pieza-por-pieza (to-do list).
 *   - Botón "Confirmar entrega" sólo se habilita con todos los checks.
 *
 * Fuera de alcance (futuro): QR de entrega, paquetería a domicilio.
 */
@ApiTags('Pedidos - Mostrador')
@Controller('pedidos/mostrador')
@Roles(RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
@ApiBearerAuth()
export class MostradorController {
  constructor(private readonly mostradorService: MostradorService) {}

  @Get('listos')
  @ApiOperation({
    summary:
      'Pedidos de la tienda del usuario en PAID o SHIPPED, listos para entregar',
  })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async listarListos(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    // ADMIN puede ver todas las tiendas; el resto, sólo la suya.
    const tienda =
      user.rol === RolUsuario.ADMIN && tiendaId
        ? parseInt(tiendaId, 10)
        : user.tiendaId;
    return this.mostradorService.obtenerPedidosListos(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
    );
  }

  @Get('buscar')
  @ApiOperation({
    summary:
      'Búsqueda rápida por número de pedido o nombre del cliente (sufijo/contains)',
  })
  async buscar(
    @Query() query: BuscarPedidoDto,
    @CurrentUser() user: any,
  ) {
    if (!query.q || query.q.trim().length < 2) {
      return { data: [] };
    }
    const data = await this.mostradorService.buscarPedidos(
      query.q.trim(),
      user,
      user.tiendaId,
    );
    return { data };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalle completo del pedido (items, mensajes, historial). Valida tienda.',
  })
  async obtenerPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.obtenerPedido(id, user);
  }

  @Post(':id/entregar')
  @ApiOperation({
    summary:
      'PAID|SHIPPED → COMPLETED. Confirma que el cliente recogió el pedido en tienda.',
  })
  async entregar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.entregar(id, user);
  }
}
