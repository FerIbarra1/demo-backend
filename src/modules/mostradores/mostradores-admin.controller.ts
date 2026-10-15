import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '@prisma/client';
import { MostradoresService } from './mostradores.service';
import { CrearMostradoresDto, RenumerarMostradorDto } from './dto/mostradores.dto';

/**
 * Endpoints admin para gestionar los mostradores físicos de una tienda.
 *  - GET    /admin/mostradores/:tiendaId
 *  - POST   /admin/mostradores/:tiendaId       (crear N)
 *  - PATCH  /admin/mostradores/:tiendaId/:id   (renumerar)
 *  - DELETE /admin/mostradores/:tiendaId/:id
 */
@ApiTags('Admin - Mostradores')
@ApiBearerAuth()
@Controller('admin/mostradores')
@Roles(RolUsuario.ADMIN)
export class MostradoresAdminController {
  constructor(private readonly service: MostradoresService) {}

  @Get(':tiendaId')
  @ApiOperation({ summary: 'Listar mostradores de una tienda' })
  listar(@Param('tiendaId', ParseIntPipe) tiendaId: number) {
    return this.service.listarPorTienda(tiendaId);
  }

  @Post(':tiendaId')
  @ApiOperation({ summary: 'Crear N mostradores nuevos (numerados correlativamente)' })
  crear(@Param('tiendaId', ParseIntPipe) tiendaId: number, @Body() dto: CrearMostradoresDto) {
    return this.service.crearN(tiendaId, dto.cantidad);
  }

  @Patch(':tiendaId/:id')
  @ApiOperation({ summary: 'Renumerar un mostrador' })
  renumerar(
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenumerarMostradorDto,
  ) {
    return this.service.renumerar(tiendaId, id, dto.numero);
  }

  @Delete(':tiendaId/:id')
  @ApiOperation({ summary: 'Borrar un mostrador libre (no ocupado)' })
  borrar(@Param('tiendaId', ParseIntPipe) tiendaId: number, @Param('id', ParseIntPipe) id: number) {
    return this.service.borrar(tiendaId, id);
  }
}
