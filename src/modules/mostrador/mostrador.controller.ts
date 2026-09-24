import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { MostradorService } from './mostrador.service';
import { BuscarPedidoDto } from './dto/buscar-pedido.dto';
import {
  AjustarPedidoDto,
  CancelarPedidoDto,
  LiberarPedidoDto,
} from './dto/accion-mostrador.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * Consola del Mostrador (jul 2026).
 *
 * F16 (sep 2026): el mostrador pasó de ser la última parada a la penúltima.
 * Ahora tiene DOS colas y cinco acciones:
 *
 *   Cola "por revisar" (`EN_MOSTRADOR`):
 *     - `POST :id/liberar`  → PENDING_PAID (aquí entra al ERP)
 *     - `POST :id/ajustar`  → REVIEWING (el cliente pidió cambios)
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
  constructor(private readonly mostradorService: MostradorService) {}

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
      'F16: pedidos en EN_MOSTRADOR esperando revisión con el cliente. ' +
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
      user.rol === RolUsuario.ADMIN && tiendaId
        ? parseInt(tiendaId, 10)
        : user.tiendaId;
    return this.mostradorService.obtenerCola(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
    );
  }

  @Get('listos')
  @ApiOperation({
    summary:
      'Pedidos de la tienda del usuario en PAID o SHIPPED, listos para entregar',
  })
  @ApiQuery({ name: 'tiendaId', required: false, type: Number })
  @ApiQuery({ name: 'pagina', required: false, type: Number })
  @ApiQuery({ name: 'limite', required: false, type: Number })
  @ApiQuery({
    name: 'orden',
    required: false,
    enum: ['esperando', 'pago'],
    description:
      'esperando (default): avisos de llegada primero. pago: solo FIFO por fechaPago.',
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
      user.rol === RolUsuario.ADMIN && tiendaId
        ? parseInt(tiendaId, 10)
        : user.tiendaId;
    return this.mostradorService.obtenerPedidosListos(
      tienda,
      pagina ? parseInt(pagina, 10) : 1,
      limite ? parseInt(limite, 10) : 20,
      orden ?? 'esperando',
    );
  }

  @Get('buscar')
  @ApiOperation({
    summary:
      'Búsqueda rápida por número de pedido o nombre del cliente (sufijo/contains)',
  })
  async buscar(
    @Query() query: BuscarPedidoDto,
    @CurrentUser() user: any,
  ) {
    if (!query.q || query.q.trim().length < 2) {
      return { data: [] };
    }
    const data = await this.mostradorService.buscarPedidos(
      query.q.trim(),
      user,
      user.tiendaId,
    );
    return { data };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Detalle completo del pedido (items, mensajes, historial). Valida tienda.',
  })
  async obtenerPedido(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.obtenerPedido(id, user);
  }

  @Post(':id/entregar')
  @ApiOperation({
    summary:
      'PAID|SHIPPED → COMPLETED. Confirma que el cliente recogió el pedido en tienda.',
  })
  async entregar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.entregar(id, user);
  }

  // ------------------------------------------------------------------
  // F16 (sep 2026): las tres acciones sobre un pedido en EN_MOSTRADOR
  // ------------------------------------------------------------------

  @Post(':id/llamar')
  @ApiOperation({
    summary:
      'F16: manda a llamar al cliente. NO cambia el estado — emite ' +
      '`pedido.llamado-mostrador` para que la TV muestre la alerta. Es el ' +
      'canal de aviso del flujo (el cliente ve su folio en la pantalla).',
  })
  async llamar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.llamar(id, user);
  }

  @Post(':id/descartar-llegada')
  @ApiOperation({
    summary:
      'F16: descarta un aviso de llegada falso (el cliente no estaba). ' +
      'No cambia el estado — solo quita el badge "EN TIENDA".',
  })
  async descartarLlegada(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.descartarLlegada(id, user);
  }

  @Post(':id/liberar')
  @ApiOperation({
    summary:
      'EN_MOSTRADOR → PENDING_PAID. El cliente aprobó su pedido; pasa a caja. ' +
      'AQUÍ se encola a Firebird (el ERP solo ve pedidos ya confirmados).',
  })
  async liberar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LiberarPedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.liberar(id, user, dto.nota);
  }

  @Post(':id/ajustar')
  @ApiOperation({
    summary:
      'EN_MOSTRADOR → REVIEWING. El cliente pidió cambios; el pedido vuelve ' +
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
    summary:
      'EN_MOSTRADOR → CANCELLED + lista de reposición. La mercancía vuelve al anaquel.',
  })
  async cancelar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelarPedidoDto,
    @CurrentUser() user: any,
  ) {
    return this.mostradorService.cancelar(id, user, dto.motivo);
  }
}
