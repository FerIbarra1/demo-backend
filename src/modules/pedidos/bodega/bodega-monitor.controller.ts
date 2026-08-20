import { Controller, Get, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MonitorService } from './monitor.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Monitor Bodega')
@ApiBearerAuth()
@Controller('bodega/pedidos/monitor')
@Roles(RolUsuario.BODEGA_MONITOR, RolUsuario.ADMIN)
export class BodegaMonitorController {
  constructor(private readonly monitorService: MonitorService) {}

  /**
   * Foto completa del monitor para una sola tienda (la del usuario).
   * Devuelve: equipo activo, contadores, pedidos en tienda y web, todo ordenado
   * por urgencia. Es lo que el frontend pide cada 5s con polling.
   */
  @Get()
  @ApiOperation({
    summary: 'Snapshot del monitor de bodega (equipo + pedidos + contadores)',
  })
  async obtener(@CurrentUser() user: any) {
    const tiendaId = user.tiendaId;
    if (!tiendaId) {
      throw new BadRequestException(
        'Tu usuario no tiene tienda asignada. Contacta al administrador.',
      );
    }
    return this.monitorService.obtenerMonitor(tiendaId);
  }

  /**
   * Sólo el equipo de bodega de la tienda del usuario.
   * Útil para poblar un dropdown de re-asignación sin pedir el snapshot completo.
   */
  @Get('equipo')
  @ApiOperation({ summary: 'Lista de bodegueros activos de la tienda' })
  async obtenerEquipo(@CurrentUser() user: any) {
    const snapshot = await this.monitorService.obtenerMonitor(user.tiendaId);
    return snapshot.equipo;
  }
}
