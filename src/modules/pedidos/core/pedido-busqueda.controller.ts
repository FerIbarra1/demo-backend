import {
  Controller,
  Get,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../prisma/prisma.service';
import { PedidoAccessService } from './pedido-access.service';

/**
 * Búsqueda de pedido por folio (QR). Accesible por empleados (BODEGA, CAJERO,
 * MOSTRADOR, ADMIN). El folio puede ser el de VFP (externalFolio) o el interno
 * (numeroPedido). Valida que el pedido pertenezca a la tienda del empleado
 * (reutiliza PedidoAccessService.cargarYValidar).
 *
 * Clientes NO pueden usar este endpoint (RolesGuard lo rechaza).
 */
@ApiTags('Pedidos - Búsqueda por folio')
@Controller('pedidos/buscar-por-folio')
@Roles(RolUsuario.BODEGA, RolUsuario.CAJERO, RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidoBusquedaController {
  constructor(
    private prisma: PrismaService,
    private access: PedidoAccessService,
  ) {}

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
    const f = (folio ?? '').trim();
    if (!f) {
      throw new NotFoundException('Folio requerido');
    }

    const pedido = await this.prisma.pedido.findFirst({
      where: {
        OR: [
          { numeroPedido: { equals: f, mode: 'insensitive' } },
          { pendienteEnvio: { externalFolio: { equals: f, mode: 'insensitive' } } },
        ],
      },
      include: {
        pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
      },
    });

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    // Valida tienda (y rol). Lanza 403 si el pedido es de otra tienda.
    await this.access.cargarYValidar(pedido.id, user);

    return {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      externalFolio: pedido.pendienteEnvio?.externalFolio ?? null,
      estado: pedido.estado,
    };
  }
}
