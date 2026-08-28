import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { VentanillasService } from './ventanillas.service';

/**
 * Endpoints del cajero para elegir / liberar la ventanilla donde trabaja.
 *  - GET   /cajero/ventanilla              (la mía actual)
 *  - GET   /cajero/ventanilla/disponibles  (todas las de la tienda)
 *  - POST  /cajero/ventanilla/elegir      body { ventanillaId }
 *  - POST  /cajero/ventanilla/liberar     body opcional { ventanillaId }
 */
@ApiTags('Cajero - Ventanilla')
@ApiBearerAuth()
@Controller('cajero/ventanilla')
@Roles(RolUsuario.CAJERO, RolUsuario.ADMIN)
export class VentanillasCajeroController {
  constructor(private readonly service: VentanillasService) {}

  @Get()
  @ApiOperation({ summary: 'Ventanilla asignada al cajero actual (o null)' })
  async miVentanilla(@CurrentUser() user: any) {
    if (!user.tiendaId) return null;
    return this.service.ventanillaDelCajero(user.userId, user.tiendaId);
  }

  @Get('disponibles')
  @ApiOperation({ summary: 'Listar todas las ventanillas de la tienda del cajero' })
  disponibles(@CurrentUser() user: any) {
    return this.service.listarPorTienda(user.tiendaId);
  }

  @Post('elegir')
  @ApiOperation({ summary: 'Elegir la ventanilla donde trabaja el cajero' })
  async elegir(
    @CurrentUser() user: any,
    @Body() body: { ventanillaId: number },
  ) {
    return this.service.elegir(user.userId, user.tiendaId, body.ventanillaId);
  }

  @Post('liberar')
  @ApiOperation({ summary: 'Liberar la ventanilla del cajero (logout / cambio)' })
  async liberar(
    @CurrentUser() user: any,
    @Body() body: { ventanillaId?: number },
  ) {
    return this.service.liberar(user.userId, user.tiendaId, body.ventanillaId);
  }
}
