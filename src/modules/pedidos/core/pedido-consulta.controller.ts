import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import {
  ApiTiendaConsola,
  TiendaConsola,
  TiendaConsolaGuard,
} from '../../../common/tienda-consola';
import { MostradorQueryService } from '../../mostrador/mostrador-query.service';
import { PedidoStateService } from './pedido-state.service';
import { responsableDe, puedeOperar, mensajeNoEsTuyo } from './escaneo.util';
import { BuscarPedidoDto } from '../../mostrador/dto/buscar-pedido.dto';

/**
 * F17 (oct 2026): la CONSULTA de pedidos, compartida por todas las consolas de
 * empleado.
 *
 * El caso de uso: un cliente dicta su nombre (o trae el ticket, o el folio) y
 * el empleado tiene que encontrar su pedido — sin importar en qué etapa esté ni
 * en qué consola esté el empleado. Antes cada rol tenía su propio buscador, y
 * **3 de los 4 filtraban solo la página visible** (bodega, cajero y ventas no
 * tenían endpoint de búsqueda): con el límite default de 10, encontrar un
 * pedido entre 300 era imposible.
 *
 * Este controller NO reimplementa la búsqueda: expone la que ya existía en
 * `MostradorQueryService.buscarPedidos`, que ya buscaba en todos los estados
 * por folio interno, folio de VFP, nombre y correo. Solo se le quita el candado
 * de rol que la encerraba en mostrador.
 *
 * **La regla de tienda es la misma y no se toca:** la de un empleado sale SOLO
 * del JWT, nunca de un header ni de `?tiendaId=`. Un empleado no puede ver
 * pedidos de otra tienda (ver `PedidoAccessService.validar`). El ADMIN, que no
 * trae tienda en el token, elige la suya con `?tiendaId=` (`@TiendaConsola()`).
 *
 * El detalle delega en `PedidoStateService.obtenerDetalle`, que ya valida
 * tienda y ya devuelve items, historial, propuestas y `pendienteEnvio`.
 */
@ApiTags('Pedidos - Consulta')
@UseGuards(TiendaConsolaGuard)
@Controller('pedidos/consulta')
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
export class PedidoConsultaController {
  constructor(
    private readonly mostradorQuery: MostradorQueryService,
    private readonly pedidoState: PedidoStateService,
  ) {}

  @Get('buscar')
  @ApiOperation({
    summary:
      'Busca pedidos de la tienda del usuario en TODOS los estados, por folio ' +
      'interno, folio de VFP, nombre o correo. Paginado.',
  })
  @ApiQuery({ name: 'q', required: true, type: String, description: 'Mínimo 2 caracteres.' })
  @ApiTiendaConsola()
  async buscar(
    @Query() query: BuscarPedidoDto,
    @CurrentUser() user: any,
    @TiendaConsola() tienda: number,
  ) {
    // Menos de 2 caracteres devuelve vacío en vez de la tienda entera: el
    // buscador del frontend dispara por debounce y no queremos un listado
    // completo en cada tecla.
    if (!query.q || query.q.trim().length < 2) {
      return {
        data: [],
        meta: { total: 0, pagina: 1, limite: query.limite ?? 20, totalPaginas: 0 },
      };
    }
    return this.mostradorQuery.buscarPedidos(
      query.q.trim(),
      user,
      tienda,
      query.pagina ?? 1,
      query.limite ?? 20,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalle completo del pedido (items, historial, propuestas) + quién lo ' +
      'tiene y si a este usuario le toca operarlo. Valida tienda.',
  })
  async detalle(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    // `obtenerDetalle` ya llama a `cargarYValidar`, que lanza 403 si el pedido
    // es de otra tienda y 404 si no existe.
    const pedido = await this.pedidoState.obtenerDetalle(id, user);

    // F17: la MISMA información de "¿me toca?" que usa el escáner, para que el
    // modal no tenga que duplicar el mapa de responsables. Si el frontend
    // copiara `RESPONSABLES`, tendríamos la regla en dos lugares — y el día que
    // se agregue un estado, uno de los dos quedaría desactualizado sin que nada
    // lo detecte. Es el bug que `aplicarCambiosFisicos` vino a corregir.
    const responsable = responsableDe(pedido.estado);
    const puedeOperarAqui = puedeOperar(pedido.estado, user.rol);

    return {
      ...pedido,
      /** Quién lo tiene ahora. `rol: null` en estados terminales. */
      responsable: {
        rol: responsable.rol,
        label: responsable.label,
        queHace: responsable.queHace,
      },
      /** ¿A este usuario le toca operarlo? Decide acción primaria vs. lectura. */
      puedeOperar: puedeOperarAqui,
      /** Explicación cuando NO es suyo. Nunca un 403 seco. */
      mensaje: puedeOperarAqui ? null : mensajeNoEsTuyo(pedido.estado),
    };
  }
}
