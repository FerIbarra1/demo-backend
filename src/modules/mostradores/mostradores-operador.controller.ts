import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { MostradoresService } from './mostradores.service';
import { ElegirMostradorDto, LiberarMostradorDto } from './dto/mostradores.dto';

/**
 * Endpoints del operador para elegir / liberar el mostrador donde trabaja.
 *  - GET   /mostrador/puesto              (el mío actual, o null)
 *  - GET   /mostrador/puesto/disponibles  (todos los de la tienda)
 *  - POST  /mostrador/puesto/elegir       body { mostradorId }
 *  - POST  /mostrador/puesto/liberar      body opcional { mostradorId }
 *
 * Vive bajo `mostrador/puesto` y NO bajo `pedidos/mostrador`: ese prefijo ya
 * tiene un `@Get(':id')` con `ParseIntPipe` que se comería `puesto` con un 400.
 */
@ApiTags('Mostrador - Puesto')
@ApiBearerAuth()
@Controller('mostrador/puesto')
@Roles(RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
export class MostradoresOperadorController {
  constructor(private readonly service: MostradoresService) {}

  @Get()
  @ApiOperation({ summary: 'Mostrador asignado al operador actual (o null)' })
  async miMostrador(@CurrentUser() user: any) {
    if (!user.tiendaId) return null;
    return this.service.delOperadorConCarga(user.userId, user.tiendaId);
  }

  @Get('disponibles')
  @ApiOperation({ summary: 'Listar todos los mostradores de la tienda del operador' })
  disponibles(@CurrentUser() user: any) {
    // El ADMIN no trae tienda y no ocupa mostradores (D3): sin esto llegaba `undefined` a Prisma y su
    // consola de mostrador daba 500 al abrir el selector. Lo mismo que ya hace `miMostrador`.
    if (!user.tiendaId) return [];
    return this.service.listarPorTienda(user.tiendaId);
  }

  @Post('elegir')
  @ApiOperation({ summary: 'Elegir el mostrador donde trabaja el operador' })
  elegir(@CurrentUser() user: any, @Body() dto: ElegirMostradorDto) {
    return this.service.elegir(user.userId, user.tiendaId, dto.mostradorId, dto.forzar === true);
  }

  @Post('liberar')
  @ApiOperation({ summary: 'Liberar el mostrador del operador (cierre de sesión / cambio)' })
  liberar(@CurrentUser() user: any, @Body() dto: LiberarMostradorDto) {
    return this.service.liberar(user.userId, user.tiendaId, dto.mostradorId);
  }
}
