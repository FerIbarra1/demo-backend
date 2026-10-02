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
import { PrismaService } from '../../../prisma/prisma.service';
import {
  responsableDe,
  puedeOperar,
  mensajeNoEsTuyo,
} from './escaneo.util';
import { estadoPedidoLabel } from '../../mail/estado-labels';

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
  constructor(
    private readonly access: PedidoAccessService,
    private readonly prisma: PrismaService,
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
    return this.access.buscarPorFolio(folio, user);
  }

  /**
   * Oct 2026: resuelve un código escaneado a una superficie de acción.
   *
   * El escáner navegaba a una ruta fija del rol, así que escanear un pedido que
   * ya había salido de bodega dejaba al operador en una página que no aplicaba.
   * Este endpoint devuelve lo que el panel necesita para decidir QUÉ ofrecer:
   * en qué etapa está el pedido, quién lo tiene, y si a este usuario le toca
   * operarlo.
   *
   * El frontend ya no decide la ruta por rol: recibe `puedeOperar` y
   * `rutaAccion`, y el panel muestra la acción primaria o el modo solo lectura.
   *
   * Sigue validando tienda: un empleado no puede escanear el pedido de otra
   * tienda (403 de `buscarPorFolio`).
   */
  @Get('resolver')
  @ApiOperation({
    summary:
      'Oct 2026: resuelve un código escaneado (folio o QR) a un panel de acción ' +
      'con el estado, quién lo tiene y si a este usuario le toca operarlo.',
  })
  @ApiQuery({ name: 'folio', required: true, type: String })
  async resolverEscaneo(
    @Query('folio') folio: string,
    @CurrentUser() user: any,
  ) {
    // Reusa la búsqueda existente: resuelve el folio (interno o de VFP) y
    // valida tienda/rol. Lanza 404 si no existe, 403 si es de otra tienda.
    const base = await this.access.buscarPorFolio(folio, user);

    const pedido = await this.prisma.pedido.findUnique({
      where: { id: base.id },
      select: {
        id: true,
        numeroPedido: true,
        clienteNombre: true,
        estado: true,
        canalOrigen: true,
        total: true,
        tienda: { select: { nombre: true } },
        _count: { select: { items: true } },
      },
    });
    if (!pedido) {
      // Carrera: se borró entre la búsqueda y el detalle.
      return { encontrado: false as const };
    }

    const responsable = responsableDe(pedido.estado);
    const puedeOperarAqui = puedeOperar(pedido.estado, user.rol);

    return {
      encontrado: true as const,
      pedido: {
        id: pedido.id,
        numeroPedido: pedido.numeroPedido,
        clienteNombre: pedido.clienteNombre,
        estado: pedido.estado,
        estadoLabel: estadoPedidoLabel(pedido.estado),
        canalOrigen: pedido.canalOrigen,
        total: Number(pedido.total),
        itemsCount: pedido._count.items,
        tiendaNombre: pedido.tienda.nombre,
      },
      /** Quién lo tiene ahora. `rol: null` en estados terminales. */
      responsable: {
        rol: responsable.rol,
        label: responsable.label,
        queHace: responsable.queHace,
      },
      /** ¿A este usuario le toca operarlo? Decide acción primaria vs. solo lectura. */
      puedeOperar: puedeOperarAqui,
      /** Explicación para el operador cuando NO es suyo. Nunca un 403 seco. */
      mensaje: puedeOperarAqui ? null : mensajeNoEsTuyo(pedido.estado),
      /**
       * Ruta del detalle según el rol del usuario. `null` si su rol no tiene
       * página de detalle (cajero) — el panel entonces no ofrece "Ir al pedido".
       */
      rutaAccion: rutaDetallePara(user.rol, pedido.id),
    };
  }
}

/**
 * Ruta de detalle de pedido por rol. Espejo de las rutas del App Router del
 * frontend (`(warehouse)/bodega/pedidos/[id]`, `(counter)/mostrador/[id]`, …).
 *
 * El cajero devuelve `null` a propósito: no tiene página de detalle, su trabajo
 * se hace entero en la consola de ventanillas. Ofrecerle un botón que lleva a
 * un 404 sería peor que no ofrecerlo.
 */
function rutaDetallePara(rol: RolUsuario, pedidoId: number): string | null {
  switch (rol) {
    case RolUsuario.BODEGA:
    case RolUsuario.BODEGA_MONITOR:
      return `/bodega/pedidos/${pedidoId}`;
    case RolUsuario.MOSTRADOR:
    case RolUsuario.MOSTRADOR_MONITOR:
      return `/mostrador/${pedidoId}`;
    case RolUsuario.VENTAS:
      return `/ventas/pedidos/${pedidoId}`;
    case RolUsuario.ADMIN:
      return `/admin/pedidos/${pedidoId}`;
    default:
      return null;
  }
}
