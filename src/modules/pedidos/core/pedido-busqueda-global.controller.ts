import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, OmitType } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { MostradorQueryService } from '../../mostrador/mostrador-query.service';
import { BuscarPedidoDto } from '../../mostrador/dto/buscar-pedido.dto';

/**
 * Lo mismo que `BuscarPedidoDto` SIN `tiendaId`. Esta búsqueda es de TODAS las tiendas: un `?tiendaId=` aquí no
 * tendría efecto, y ignorarlo en silencio (lo que haría el DTO normal, donde el campo existe para dejarlo pasar al
 * `ValidationPipe`) haría creer a quien llama que está acotando. Con `forbidNonWhitelisted` es un 400 explícito.
 */
export class BuscarPedidoGlobalDto extends OmitType(BuscarPedidoDto, ['tiendaId'] as const) {}

/**
 * N2 (PLAN-ADMIN-MULTITIENDA §10 / §14, oct 2026): la BÚSQUEDA GLOBAL de pedido, solo para el ADMIN.
 *
 * "¿Dónde está el pedido PD-…?" sin adivinar la tienda. El buscador de las consolas (`pedidos/consulta/buscar`) es
 * de UNA tienda a propósito (D1: una tienda a la vez; un empleado nunca ve otra). Esta es la única ruta que busca en
 * todas, y por eso es un controller APARTE con `@Roles(ADMIN)` a nivel de clase: si fuera un método más de
 * `PedidoConsultaController` (cuyo `@Roles` incluye a los 5 roles de empleado), bastaría con que alguien le quitara
 * el `@Roles` del método para abrirle a un cajero los pedidos de todas las tiendas. Un spec lo fija por HTTP.
 *
 * No reimplementa la búsqueda: `MostradorQueryService.buscarPedidos` sin tienda ya busca en todas (acentos,
 * teléfono, palabras sueltas, folio de VFP) y cada fila trae su `tienda`, que es lo que la pantalla pinta para decir
 * en cuál está. Vive en `MostradorModule` por la misma razón que `PedidoConsultaController` (depende de
 * `MostradorQueryService`; poner esto en `PedidosModule` crearía un ciclo).
 *
 * El detalle del resultado NO necesita ruta nueva: `GET pedidos/consulta/:id` ya exime al ADMIN de la tienda
 * (`cargarYValidar`).
 */
@ApiTags('Pedidos - Consulta')
@Controller('admin/busqueda/pedidos')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class PedidoBusquedaGlobalController {
  constructor(private readonly mostradorQuery: MostradorQueryService) {}

  @Get()
  @ApiOperation({
    summary:
      'Solo ADMIN: busca pedidos en TODAS las tiendas y en todos los estados, por folio interno, folio de VFP, ' +
      'nombre, correo o teléfono. Cada fila trae su `tienda`. Paginado.',
  })
  @ApiQuery({ name: 'q', required: true, type: String, description: 'Mínimo 2 caracteres.' })
  async buscar(@Query() query: BuscarPedidoGlobalDto, @CurrentUser() user: any) {
    // Menos de 2 caracteres devuelve vacío (no todas las tiendas enteras): el buscador dispara por debounce.
    if (!query.q || query.q.trim().length < 2) {
      return {
        data: [],
        meta: { total: 0, pagina: 1, limite: query.limite ?? 20, totalPaginas: 0 },
      };
    }
    // `undefined` = sin tienda: la búsqueda global. Es el único camino que lo permite, y solo se llega con ADMIN.
    return this.mostradorQuery.buscarPedidos(
      query.q.trim(),
      user,
      undefined,
      query.pagina ?? 1,
      query.limite ?? 20,
    );
  }
}
