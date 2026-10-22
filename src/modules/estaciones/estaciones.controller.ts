import { Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { VentanillasService } from '../ventanillas/ventanillas.service';
import { BodegaPresenciaService } from './bodega-presencia.service';

/**
 * F3.5 (oct 2026, "cubrir puesto"): el ADMIN puede ocupar una ventanilla y tomar pedidos de bodega en la tienda que
 * opera. Un puesto es de UNA tienda: al cambiar de tienda (o al cerrar sesión) se SUELTAN, y lo que traía en las
 * manos vuelve a la fila / a la cola. Lo llama la pantalla antes de cambiar de tienda; el barrido de inactividad es
 * la red de seguridad de quien cierra la pestaña.
 */
@ApiTags('Estaciones')
@ApiBearerAuth()
@Controller('estaciones')
@Roles(RolUsuario.ADMIN)
export class EstacionesController {
  constructor(
    private readonly ventanillas: VentanillasService,
    private readonly bodegueros: BodegaPresenciaService,
  ) {}

  @Post('soltar')
  @ApiOperation({
    summary:
      'Suelta los puestos del ADMIN en cualquier tienda: su ventanilla (con sus pedidos de vuelta a la fila) y ' +
      'los pedidos de bodega que traía (de vuelta a la cola).',
  })
  async soltar(@CurrentUser('userId') userId: number) {
    const ventanilla = await this.ventanillas.liberarDelUsuario(userId);
    const bodega = await this.bodegueros.salio(userId, { soloPedidos: true });
    return {
      ventanilla: ventanilla
        ? { numero: ventanilla.numero, pedidosRegresados: ventanilla.pedidosRegresadosALaFila }
        : null,
      pedidosDeBodegaRegresados: bodega.pedidosRegresados,
    };
  }
}
