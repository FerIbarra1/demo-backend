import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiTiendaConsola, TiendaConsola, TiendaConsolaGuard } from '../../common/tienda-consola';
import { DestrabarService } from './destrabar.service';
import { TareasErpService } from './tareas-erp.service';
import { EjecutarAccionDto, ResolverTareaDto } from './dto/destrabar.dto';

/**
 * Oct 2026: destrabar un pedido. `@Roles(GERENTE)` de CLASE (el ADMIN pasa siempre): el gerente lo hace en SU tienda
 * (`cargarYValidar` compara con la tienda de su token). Los demás roles reciben 403: cada uno conserva las acciones
 * de su consola.
 */
@ApiTags('Destrabar pedidos')
@Controller('pedidos/:id/destrabar')
@Roles(RolUsuario.GERENTE)
@ApiBearerAuth()
export class DestrabarController {
  constructor(private readonly destrabar: DestrabarService) {}

  @Get()
  @ApiOperation({
    summary:
      'Qué acciones caben en este pedido (lo decide el servidor), su bitácora y lo pendiente en el Sistema Comercial.',
  })
  obtener(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.destrabar.obtener(id, user);
  }

  @Post(':accion')
  @ApiOperation({
    summary: 'Ejecuta una acción de destrabar. El motivo es obligatorio y queda en la bitácora.',
  })
  ejecutar(
    @Param('id', ParseIntPipe) id: number,
    @Param('accion') accion: string,
    @Body() dto: EjecutarAccionDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.destrabar.ejecutar(id, accion, dto, user, req.ip);
  }
}

/**
 * Oct 2026: las tareas del Sistema Comercial de UNA tienda. La ve y la cierra el CAJERO (es quien opera el Sistema
 * Comercial), el GERENTE y el ADMIN. La tienda sale del token (`@TiendaConsola`).
 */
@ApiTags('Destrabar pedidos')
@UseGuards(TiendaConsolaGuard)
@Controller('tareas-erp')
@Roles(RolUsuario.CAJERO, RolUsuario.GERENTE)
@ApiBearerAuth()
export class TareasErpController {
  constructor(private readonly tareas: TareasErpService) {}

  @Get()
  @ApiTiendaConsola()
  @ApiOperation({
    summary:
      'Pendientes de reflejar en el Sistema Comercial (cancelar allá, registrar un cobro allá).',
  })
  listar(@TiendaConsola() tienda: number) {
    return this.tareas.listar(tienda);
  }

  @Post(':id/hecha')
  @ApiOperation({ summary: '"Ya lo hice en el Sistema Comercial".' })
  hecha(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolverTareaDto,
    @CurrentUser() user: any,
  ) {
    return this.tareas.resolver(id, 'MANUAL', dto.nota, user);
  }

  @Post(':id/descartar')
  @Roles(RolUsuario.GERENTE)
  @ApiOperation({ summary: '"No aplica" (solo gerente y admin; la nota es obligatoria).' })
  descartar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolverTareaDto,
    @CurrentUser() user: any,
  ) {
    return this.tareas.resolver(id, 'DESCARTADA', dto.nota, user);
  }
}
