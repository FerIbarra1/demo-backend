import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { SaludSistemaService } from './salud-sistema.service';

/** N3 (oct 2026): la salud del sistema, solo ADMIN (`@Roles` de clase): muestra errores y rutas internas del ERP. */
@ApiTags('Admin - Salud del sistema')
@Controller('admin/salud')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class SaludSistemaController {
  constructor(private readonly salud: SaludSistemaService) {}

  @Get()
  @ApiOperation({
    summary:
      'Solo ADMIN: agente del Sistema Comercial y bandeja por tienda, eventos de sync fallidos, kioskos, TVs de bodega, ' +
      'outbox de realtime y barridos, con un semáforo por umbral.',
  })
  obtener() {
    return this.salud.obtener();
  }
}
