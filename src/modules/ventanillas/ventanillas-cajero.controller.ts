import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiTiendaConsola, TiendaConsola, TiendaConsolaGuard } from '../../common/tienda-consola';
import { RolUsuario } from '@prisma/client';
import { VentanillasService } from './ventanillas.service';

/**
 * Endpoints del cajero para elegir / liberar la ventanilla donde trabaja.
 *  - GET   /cajero/ventanilla              (la mía actual EN ESTA TIENDA)
 *  - GET   /cajero/ventanilla/disponibles  (todas las de la tienda)
 *  - POST  /cajero/ventanilla/elegir      body { ventanillaId }
 *  - POST  /cajero/ventanilla/liberar     body opcional { ventanillaId }
 *
 * F3.5 (oct 2026, "cubrir puesto"): la tienda sale de `@TiendaConsola()`: la del token para un cajero y la que
 * el ADMIN está operando para él. El ADMIN no tiene tienda en su cuenta; antes `disponibles` le daba `[]` y no
 * podía ocupar una ventanilla, y sin una no puede tomar pedidos en caja (ver `CajeroService`).
 */
@ApiTags('Cajero - Ventanilla')
@ApiBearerAuth()
@UseGuards(TiendaConsolaGuard)
@Controller('cajero/ventanilla')
@Roles(RolUsuario.CAJERO, RolUsuario.ADMIN)
export class VentanillasCajeroController {
  constructor(private readonly service: VentanillasService) {}

  @Get()
  @ApiOperation({ summary: 'Ventanilla asignada al cajero actual en esta tienda (o null)' })
  @ApiTiendaConsola()
  async miVentanilla(@CurrentUser() user: any, @TiendaConsola({ opcional: true }) tienda?: number) {
    if (!tienda) return null;
    return this.service.ventanillaDelCajero(user.userId, tienda);
  }

  @Get('disponibles')
  @ApiOperation({ summary: 'Listar todas las ventanillas de la tienda' })
  @ApiTiendaConsola()
  disponibles(@TiendaConsola() tienda: number) {
    return this.service.listarPorTienda(tienda);
  }

  @Post('elegir')
  @ApiOperation({
    summary: 'Elegir la ventanilla donde trabaja el cajero (o el ADMIN que cubre un puesto)',
  })
  @ApiTiendaConsola()
  async elegir(
    @CurrentUser() user: any,
    @TiendaConsola() tienda: number,
    @Body() body: { ventanillaId: number; forzar?: boolean },
  ) {
    return this.service.elegir(user.userId, tienda, body.ventanillaId, body.forzar === true);
  }

  @Post('liberar')
  @ApiOperation({ summary: 'Liberar la ventanilla del cajero (logout / cambio)' })
  @ApiTiendaConsola()
  async liberar(
    @CurrentUser() user: any,
    @TiendaConsola() tienda: number,
    @Body() body: { ventanillaId?: number },
  ) {
    return this.service.liberar(user.userId, tienda, body.ventanillaId);
  }
}
