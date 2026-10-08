import { Controller, Get, Post, Body, Param, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MostradorService } from './mostrador.service';
import { MostradorQueryService } from './mostrador-query.service';
import { BuscarPedidoDto } from './dto/buscar-pedido.dto';
import { AjustarPedidoDto, CancelarPedidoDto, EnviarAPagarDto } from './dto/accion-mostrador.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

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
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async listarCola(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    const tienda =
      user.rol === RolUsuario.ADMIN && tiendaId ? parseInt(tiendaId, 10) : user.tiendaId;
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
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'orden',
    required: false,
    enum: ['esperando', 'pago'],
    description: 'esperando (default): avisos de llegada primero. pago: solo FIFO por fechaPago.',
  })
  async listarListos(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
    @Query('orden') orden?: 'esperando' | 'pago',
  ) {
    // ADMIN puede ver todas las tiendas; el resto, sólo la suya.
    const tienda =
      user.rol === RolUsuario.ADMIN && tiendaId ? parseInt(tiendaId, 10) : user.tiendaId;
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
      'Oct 2026: pedidos web listos que nadie ha avisado que llegaron. ' +
      'El operador los identifica y marca la llegada con POST :id/marcar-llegada.',
  })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  async listarSinAviso(
    @CurrentUser() user: any,
    @Query('tiendaId') tiendaId?: string,
    @Query('pagina') pagina?: string,
    @Query('limite') limite?: string,
  ) {
    const tienda =
      user.rol === RolUsuario.ADMIN && tiendaId ? parseInt(tiendaId, 10) : user.tiendaId;
    return this.mostradorQuery.obtenerSinAviso(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
    );
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
  async buscar(@Query() query: BuscarPedidoDto, @CurrentUser() user: any) {
    if (!query.q || query.q.trim().length < 2) {
      return {
        data: [],
        meta: { total: 0, pagina: 1, limite: query.limite ?? 20, totalPaginas: 0 },
      };
    }
    return this.mostradorQuery.buscarPedidos(
      query.q.trim(),
      user,
      user.tiendaId,
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
  @ApiOperation({
    summary: 'PAID|SHIPPED → COMPLETED. Confirma que el cliente recogió el pedido en tienda.',
  })
  async entregar(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.entregar(id, user);
  }

  // ------------------------------------------------------------------
  // F16 (sep 2026): las tres acciones sobre un pedido en REVISADO
  // ------------------------------------------------------------------

  @Post(':id/llamar')
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
  @ApiOperation({
    summary:
      'Oct 2026: manda a llamar al primer pedido de la cola de revisión ' +
      '(FIFO). Espejo del `llamar-siguiente` del cajero.',
  })
  async llamarSiguiente(@CurrentUser() user: any) {
    return this.mostradorService.llamarSiguiente(user);
  }

  @Post(':id/descartar-llegada')
  @ApiOperation({
    summary:
      'F16: descarta un aviso de llegada falso (el cliente no estaba). ' +
      'No cambia el estado — solo quita el badge "EN TIENDA".',
  })
  async descartarLlegada(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.descartarLlegada(id, user);
  }

  @Post(':id/marcar-llegada')
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
  @ApiOperation({
    summary:
      'Oct 2026: deshace un "Llamar por la TV". Saca el folio del panel ' +
      '"Atendiendo" y lo regresa a la lista de espera. No cambia el estado.',
  })
  async devolverACola(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.mostradorService.devolverACola(id, user);
  }

  @Post(':id/traer-a-entrega')
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
