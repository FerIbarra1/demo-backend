import { Controller, Get, Post, Param, Query, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReposicionService } from './reposicion.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F13 (sep 2026): lista de reposición de bodega.
 *
 * Cuando el cliente rechaza una propuesta, los productos del pedido tienen que
 * volver al anaquel. Bodega ve la lista y confirma cuando ya están repuestos.
 */
@ApiTags('Pedidos - Reposición')
@Controller('bodega/reposicion')
@Roles(RolUsuario.BODEGA, RolUsuario.ADMIN)
@ApiBearerAuth()
export class ReposicionController {
  constructor(private readonly reposicionService: ReposicionService) {}

  @Get()
  @ApiOperation({
    summary: 'Reposiciones pendientes de la tienda (mercancía por devolver al anaquel)',
  })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async listar(
    @CurrentUser() user: any,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    if (!user.tiendaId) {
      throw new BadRequestException(
        'Tu usuario no tiene tienda asignada. Contacta al administrador.',
      );
    }
    return this.reposicionService.listarPendientes(
      user.tiendaId,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
    );
  }

  @Get('contador')
  @ApiOperation({ summary: 'Cuántas reposiciones pendientes tiene la tienda (badge)' })
  async contador(@CurrentUser() user: any) {
    if (!user.tiendaId) return { pendientes: 0 };
    return { pendientes: await this.reposicionService.contarPendientes(user.tiendaId) };
  }

  @Post(':pedidoId/repuesto')
  @ApiOperation({
    summary: 'Confirmar que la mercancía de un pedido cancelado volvió al anaquel',
  })
  async confirmar(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @CurrentUser() user: any,
  ) {
    return this.reposicionService.confirmarRepuesto(pedidoId, user);
  }
}
