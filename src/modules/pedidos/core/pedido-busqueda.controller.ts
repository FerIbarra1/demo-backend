import {
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PedidoAccessService } from './pedido-access.service';

/**
 * Búsqueda de pedido por folio (QR). Accesible por empleados (BODEGA, CAJERO,
 * MOSTRADOR, ADMIN). El folio puede ser el de VFP (externalFolio) o el interno
 * (numeroPedido). La búsqueda + validación de tienda vive en
 * PedidoAccessService.buscarPorFolio; el controller sólo orquesta.
 *
 * Clientes NO pueden usar este endpoint (RolesGuard lo rechaza).
 */
@ApiTags('Pedidos - Búsqueda por folio')
@Controller('pedidos/buscar-por-folio')
@Roles(RolUsuario.BODEGA, RolUsuario.CAJERO, RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidoBusquedaController {
  constructor(private readonly access: PedidoAccessService) {}

  @Get()
  @ApiOperation({
    summary:
      'Busca un pedido por folio (VFP externalFolio o numeroPedido interno). Valida tienda del empleado.',
  })
  @ApiQuery({ name: 'folio', required: true, type: String })
  async buscarPorFolio(
    @Query('folio') folio: string,
    @CurrentUser() user: any,
  ) {
    return this.access.buscarPorFolio(folio, user);
  }
}
