import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TorreControlService } from './torre-control.service';

/**
 * N1 (oct 2026): la torre de control del ADMIN. Una tarjeta por tienda, todas a la vez. `@Roles(ADMIN)` a nivel de
 * CLASE: es la única vista que junta tiendas, y un empleado no puede ver la operación de otra (D1, anti-IDOR).
 */
@ApiTags('Admin - Torre de control')
@Controller('admin/torre-control')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class TorreControlController {
  constructor(private readonly torre: TorreControlService) {}

  @Get()
  @ApiOperation({
    summary:
      'Solo ADMIN: por cada tienda activa, pedidos por etapa, la espera más larga, transferencias por verificar, ' +
      'DTF y un semáforo por umbral de espera.',
  })
  obtener(@CurrentUser() user: any) {
    return this.torre.obtener(user);
  }
}
