import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PedidoAccessService } from './pedido-access.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { responsableDe, puedeOperar, mensajeNoEsTuyo } from './escaneo.util';
import { estadoPedidoLabel } from '../../mail/estado-labels';

/**
 * Búsqueda de pedido por folio (QR). Accesible por empleados (BODEGA, CAJERO,
 * MOSTRADOR, ADMIN). El folio puede ser el de VFP (externalFolio) o el interno
 * (numeroPedido). La búsqueda + validación de tienda vive en
 * PedidoAccessService.buscarPorFolio; el controller solo orquesta.
 *
 * Clientes NO pueden usar este endpoint (RolesGuard lo rechaza).
 */
@ApiTags('Pedidos - Búsqueda por folio')
@Controller('pedidos/buscar-por-folio')
// F17 (oct 2026): VENTAS se agregó. Faltaba, y el escáner de `/ventas` monta
// `SearchInputWithScanner` → `QrScannerButton` → este endpoint, así que el
// asesor recibía un 403 silencioso (solo un toast) cada vez que escaneaba.
// El mapa de rutas por rol ya contemplaba VENTAS: la inconsistencia estaba solo aquí.
@Roles(
  RolUsuario.BODEGA,
  RolUsuario.CAJERO,
  RolUsuario.MOSTRADOR,
  RolUsuario.VENTAS,
  // Oct 2026: el gerente busca y abre pedidos de SU tienda (la tienda sale del token, como en el resto).
  RolUsuario.GERENTE,
  RolUsuario.ADMIN,
)
@ApiBearerAuth()
export class PedidoBusquedaController {
  constructor(
    private readonly access: PedidoAccessService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Busca un pedido por folio del Sistema Comercial (HMO-0000152573, 0000152573 o 152573, acotado a la tienda del empleado) o por número interno. Valida tienda del empleado.',
  })
  @ApiQuery({ name: 'folio', required: true, type: String })
  async buscarPorFolio(@Query('folio') folio: string, @CurrentUser() user: any) {
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
   * El frontend no decide la ruta por rol: recibe `puedeOperar` y muestra la
   * acción primaria o el modo solo lectura.
   *
   * F17 (oct 2026): este endpoint **ya no devuelve `rutaAccion`**. El panel del
   * escáner dejó de navegar — abre el `DetallePedidoModal` con el `pedidoId`.
   * Devolver una ruta que nadie usa es una invitación a que alguien la use y
   * aterrice en un 404 (la ruta de bodega se eliminó).
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
  async resolverEscaneo(@Query('folio') folio: string, @CurrentUser() user: any) {
    // Reusa la búsqueda existente: resuelve el folio (interno o de VFP) y
    // valida tienda/rol. Lanza 404 si no existe, 403 si es de otra tienda.
    const base = await this.access.buscarPorFolio(folio, user);

    const pedido = await this.prisma.pedido.findUnique({
      where: { id: base.id },
      select: {
        id: true,
        numeroPedido: true,
        // Oct 2026 (B2): con estas dos el servidor decora el pedido con su `folio` (HMO-0000152573).
        tiendaId: true,
        folioErp: true,
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
        tiendaId: pedido.tiendaId,
        folioErp: pedido.folioErp,
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
    };
  }
}
