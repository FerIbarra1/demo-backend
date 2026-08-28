import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '@prisma/client';
import { VentanillasService } from './ventanillas.service';

/**
 * Endpoints admin para gestionar las ventanillas físicas de una tienda.
 *  - GET    /admin/ventanillas/:tiendaId
 *  - POST   /admin/ventanillas/:tiendaId       (crear N)
 *  - PATCH  /admin/ventanillas/:tiendaId/:id   (renumerar)
 *  - DELETE /admin/ventanillas/:tiendaId/:id
 */
@ApiTags('Admin - Ventanillas')
@ApiBearerAuth()
@Controller('admin/ventanillas')
@Roles(RolUsuario.ADMIN)
export class VentanillasAdminController {
  constructor(private readonly service: VentanillasService) {}

  @Get(':tiendaId')
  @ApiOperation({ summary: 'Listar ventanillas de una tienda' })
  listar(@Param('tiendaId', ParseIntPipe) tiendaId: number) {
    return this.service.listarPorTienda(tiendaId);
  }

  @Post(':tiendaId')
  @ApiOperation({
    summary: 'Crear N ventanillas nuevas (numeradas correlativamente)',
  })
  crear(
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
    @Body() body: { cantidad: number },
  ) {
    return this.service.crearN(tiendaId, body.cantidad);
  }

  @Patch(':tiendaId/:id')
  @ApiOperation({ summary: 'Renumerar una ventanilla' })
  renumerar(
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { numero: number },
  ) {
    return this.service.renumerar(tiendaId, id, body.numero);
  }

  @Delete(':tiendaId/:id')
  @ApiOperation({ summary: 'Borrar una ventanilla libre (no ocupada)' })
  borrar(
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.borrar(tiendaId, id);
  }
}
