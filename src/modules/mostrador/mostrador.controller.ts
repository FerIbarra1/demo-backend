import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MostradorService } from './mostrador.service';
import { MostradorQueryService } from './mostrador-query.service';
import { BuscarPedidoDto } from './dto/buscar-pedido.dto';
import {
  AjustarPedidoDto,
  CancelarPedidoDto,
  CancelarVencidosDto,
  EnviarAPagarDto,
  EntregarPedidoDto,
} from './dto/accion-mostrador.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { EstacionGuard, RequiereEstacion } from '../../common/guards/estacion.guard';
import { ApiTiendaConsola, TiendaConsola, TiendaConsolaGuard } from '../../common/tienda-consola';

/**
 * Consola del Mostrador (jul 2026).
 *
 * F16 (sep 2026): el mostrador pasó de ser la última parada a la penúltima.
 * Ahora tiene DOS colas y cinco acciones:
 *
 *   Cola "por revisar" (`REVISADO`):
 *     - `POST :id/enviar-a-pagar` → PENDIENTE_PAGO (aquí entra al ERP)
 *     - `POST :id/ajustar`  → EN_REVISION (el cliente pidió cambios)
 *     - `POST :id/cancelar` → CANCELLED + reposición
 *
 *   Cola "por entregar" (`PAID` / `SHIPPED`):
 *     - `POST :id/entregar` → COMPLETED (ya existía)
 *
 * A diferencia del cajero, NO hay asignación 1:1: cualquier MOSTRADOR de la
 * tienda puede operar cualquier pedido. Es intencional para minimizar la
 * fricción operativa (el cliente llega y el primer mostrador libre lo atiende).
 */
@ApiTags('Pedidos - Mostrador')
@UseGuards(EstacionGuard, TiendaConsolaGuard)
@Controller('pedidos/mostrador')
@Roles(RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
@ApiBearerAuth()
export class MostradorController {
  constructor(
    private readonly mostradorService: MostradorService,
    private readonly mostradorQuery: MostradorQueryService,
  ) {}

  /**
   * F16: cola de pedidos apartados esperando que el cliente los revise.
   *
   * IMPORTANTE — orden de rutas: `cola` es ruta fija y va ANTES de `:id`, o
   * NestJS matchea `cola` contra `@Get(':id')` y el `ParseIntPipe` falla con
   * 400. Es el mismo problema que ya documenta `pedidos.module.ts` para
   * bodega y cajero.
   */
  @Get('cola')
  @ApiOperation({
    summary:
      'F16: pedidos en REVISADO esperando revisión con el cliente. ' +
      'Kiosko siempre visible; web solo si el cliente avisó llegada.',
  })
  @ApiTiendaConsola()
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async listarCola(
    @TiendaConsola() tienda: number,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    return this.mostradorQuery.obtenerCola(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
    );
  }

  @Get('listos')
  @ApiOperation({
    summary: 'Pedidos de la tienda del usuario en PAID o SHIPPED, listos para entregar',
  })
  @ApiTiendaConsola()
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'orden',
    required: false,
    enum: ['esperando', 'pago'],
    description: 'esperando (default): avisos de llegada primero. pago: solo FIFO por fechaPago.',
  })
  async listarListos(
    @TiendaConsola() tienda: number,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('orden') orden?: 'esperando' | 'pago',
  ) {
    return this.mostradorQuery.obtenerPedidosListos(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      orden ?? 'esperando',
    );
  }

  /**
   * Oct 2026: la cara visible del contador `sinCliente` del monitor.
   *
   * Son los pedidos web en `REVISADO` que nadie ha avisado que llegaron.
   * El gate de D5 los esconde de la cola, así que sin esta lista el operador no
   * tenía forma de encontrar al cliente que llegó sin teléfono ni folio.
   *
   * Ruta fija: va ANTES de `:id` por la misma razón que `cola` y `listos`.
   */
  @Get('sin-aviso')
  @ApiOperation({
    summary:
      'Pedidos apartados cuyo cliente NO está en la tienda (web que nadie ha avisado, o ' +
      'aviso descartado). Con antigüedad y marca de vencido. El operador los identifica ' +
      'y marca la llegada con POST :id/marcar-llegada, o cancela los vencidos.',
  })
  @ApiTiendaConsola()
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'filtro',
    required: false,
    enum: ['todos', 'vencidos'],
    description: 'vencidos: solo los que ya pasaron el plazo de espera.',
  })
  async listarSinAviso(
    @TiendaConsola() tienda: number,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('filtro') filtro?: string,
  ) {
    return this.mostradorQuery.obtenerSinAviso(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      filtro === 'vencidos' ? 'vencidos' : 'todos',
    );
  }

  /**
   * F22 (oct 2026): cancela en lote los pedidos vencidos. Ruta fija de DOS
   * segmentos distintos a `:id/...`, así que no choca con las rutas de pedido.
   */
  @Post('cancelar-vencidos')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'F22: cancela pedidos vencidos (días sin recoger y sin respuesta). Revalida cada ' +
      'uno; el cliente recibe el correo de cancelación con el motivo.',
  })
  async cancelarVencidos(@Body() dto: CancelarVencidosDto, @CurrentUser() user: any) {
    return this.mostradorService.cancelarVencidos(user, dto.ids, dto.motivo);
  }

  /**
   * Oct 2026: el buscador del operador. Es la herramienta para el cliente que
   * llega SIN ticket y SIN número de pedido.
   *
   * Antes cubría 3 de los 10 estados (EN_MOSTRADOR | PAID | SHIPPED), así que un
   * pedido que todavía estaba en bodega, esperando aprobación, en asesoría o en
   * caja NO SE ENCONTRABA. Ahora busca en todos, por folio interno, folio de
   * VFP (el del ticket), nombre y correo.
   *
   * Devuelve `{ data, meta }` como el resto de listados del mostrador: antes el
   * `take: 20` era un corte silencioso.
   */
  @Get('buscar')
  @ApiOperation({
    summary:
      'Oct 2026: busca en TODOS los estados por folio interno, folio de VFP, ' +
      'nombre o correo. Paginado.',
  })
  @ApiTiendaConsola()
  async buscar(
    @Query() query: BuscarPedidoDto,
    @CurrentUser() user: any,
    @TiendaConsola() tienda: number,
  ) {
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
    summary: 'Detalle completo del pedido (items, mensajes, historial). Valida tienda.',
  })
  async obtenerPedido(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorQuery.obtenerPedido(id, user);
  }

  @Post(':id/entregar')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'PAGADO|ENVIADO → ENTREGADO. Confirma que se recogió el pedido en tienda; `recogioNombre` (opcional) ' +
      'deja constancia de quién lo recogió cuando NO es el titular.',
  })
  async entregar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() dto: EntregarPedidoDto,
  ) {
    return this.mostradorService.entregar(id, user, dto?.recogioNombre);
  }

  // ------------------------------------------------------------------
  // F16 (sep 2026): las tres acciones sobre un pedido en REVISADO
  // ------------------------------------------------------------------

  @Post(':id/llamar')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'F16: manda a llamar al cliente. NO cambia el estado — emite ' +
      '`pedido.llamado-mostrador` para que la TV muestre la alerta. Es el ' +
      'canal de aviso del flujo (el cliente ve su folio en la pantalla).',
  })
  async llamar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.llamar(id, user);
  }

  /**
   * Oct 2026: manda a llamar al SIGUIENTE de la cola, sin elegir pedido.
   *
   * Ruta fija: va ANTES de `:id` por la misma razón que `cola` y `listos` —
   * si no, NestJS matchea `siguiente` contra `@Get(':id')` y el ParseIntPipe
   * falla con 400.
   */
  @Post('llamar-siguiente')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: manda a llamar al primer pedido de la cola de revisión ' +
      '(FIFO). Espejo del `llamar-siguiente` del cajero.',
  })
  @ApiTiendaConsola()
  async llamarSiguiente(@CurrentUser() user: any, @TiendaConsola() tienda: number) {
    // Elige de la cola de UNA tienda: la del empleado (token) o la que el ADMIN está operando.
    return this.mostradorService.llamarSiguiente(user, tienda);
  }

  @Post(':id/no-se-presento')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'F22: el cliente llamado no se presentó. Pasa al FINAL de la cola (a la 2ª vez se ' +
      'descarta su aviso). Para un error del operador usa devolver-a-cola, que conserva el lugar.',
  })
  async noSePresento(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.noSePresento(id, user);
  }

  @Post(':id/descartar-llegada')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'F16: descarta un aviso de llegada falso (el cliente no estaba). Funciona con ' +
      'kiosko y web. Si el pedido ya estaba llamado, regresa a REVISADO. El cliente ' +
      'recibe `pedido.llegada-descartada`.',
  })
  async descartarLlegada(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.descartarLlegada(id, user);
  }

  @Post(':id/marcar-llegada')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: el operador marca la llegada en nombre del cliente (llegó ' +
      'sin teléfono o sin folio). Escribe CanalLlegada.MOSTRADOR y hace ' +
      'aparecer el pedido en la cola. No cambia el estado.',
  })
  async marcarLlegada(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.marcarLlegada(id, user);
  }

  @Post(':id/devolver-a-cola')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: deshace un "Llamar por la TV". Saca el folio del panel ' +
      '"Atendiendo" y lo regresa a la lista de espera. No cambia el estado.',
  })
  async devolverACola(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.devolverACola(id, user);
  }

  @Post(':id/traer-a-entrega')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'Oct 2026: EN_ASESORIA → REVISADO. Trae al área de entrega un pedido que ' +
      'estaba con un asesor de ventas. Para el cliente que ya está enfrente y ' +
      'cuyo pedido no necesita más negociación.',
  })
  async traerAEntrega(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EnviarAPagarDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.traerAEntrega(id, user, dto.nota);
  }

  @Post(':id/enviar-a-pagar')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'REVISADO → PENDIENTE_PAGO. El cliente aprobó su pedido; pasa a caja. ' +
      'AQUÍ se encola a Firebird (el ERP solo ve pedidos ya confirmados).',
  })
  async enviarAPagar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EnviarAPagarDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.enviarAPagar(id, user, dto.nota);
  }

  @Post(':id/ajustar')
  @RequiereEstacion()
  @ApiOperation({
    summary:
      'REVISADO → EN_REVISION. El cliente pidió cambios; el pedido vuelve ' +
      'a bodega a surtir lo nuevo. Acepta los cambios de items del editor POS.',
  })
  async ajustar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AjustarPedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.ajustar(id, user, dto.nota, dto.items);
  }

  @Post(':id/cancelar')
  @RequiereEstacion()
  @ApiOperation({
    summary: 'REVISADO → CANCELLED + lista de reposición. La mercancía vuelve al anaquel.',
  })
  async cancelar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelarPedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.cancelar(id, user, dto.motivo);
  }
}
