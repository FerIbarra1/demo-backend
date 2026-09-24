import { Controller, Get, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MostradorMonitorService } from './mostrador-monitor.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F16 (sep 2026): TV del mostrador — vista READ-ONLY para la pantalla de pared.
 *
 * El rol `MOSTRADOR_MONITOR` es propio (decisión D11) y NO puede operar: solo
 * lee la cola. La operación vive en `MostradorController` (rol MOSTRADOR).
 *
 * El cliente ve su pedido aparecer aquí cuando el operador lo manda a llamar;
 * es el canal de aviso del flujo (decisión D16), no hay email.
 */
@ApiTags('Pedidos - Monitor Mostrador')
@ApiBearerAuth()
@Controller('pedidos/mostrador/monitor')
@Roles(RolUsuario.MOSTRADOR_MONITOR, RolUsuario.ADMIN)
export class MostradorMonitorController {
  constructor(private readonly monitorService: MostradorMonitorService) {}

  @Get()
  @ApiOperation({
    summary:
      'Snapshot del monitor de mostrador: cola de pedidos por revisar + contadores',
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
}
