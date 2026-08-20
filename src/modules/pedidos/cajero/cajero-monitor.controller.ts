import { Controller, Get, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MonitorService } from '../bodega/monitor.service';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

@ApiTags('Pedidos - Monitor Cajero')
@ApiBearerAuth()
@Controller('cajero/pedidos/monitor')
@Roles(RolUsuario.CAJERO_MONITOR, RolUsuario.ADMIN)
export class CajeroMonitorController {
  constructor(private readonly monitorService: MonitorService) {}

  /**
   * Snapshot del monitor de ventanillas: cajeros logueados (= ventanillas
   * activas), los pedidos KIOSKO en PENDING_PAID asignados a cada uno y la
   * cola sin asignar. Lo consume el TV cada 5s con polling + realtime.
   */
  @Get()
  @ApiOperation({
    summary:
      'Snapshot del monitor de ventanillas (cajeros + cola + contadores)',
  })
  async obtener(@CurrentUser() user: any) {
    const tiendaId = user.tiendaId;
    if (!tiendaId) {
      throw new BadRequestException(
        'Tu usuario no tiene tienda asignada. Contacta al administrador.',
      );
    }
    return this.monitorService.obtenerMonitorCajero(tiendaId);
  }
}
