import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { KioskoService } from './kiosko.service';
import { ActivarKioskoDto } from './dto/activar-kiosko.dto';
import { ActualizarKioskoDto } from './dto/actualizar-kiosko.dto';
import { ListarKioskosQueryDto } from './dto/listar-kioskos-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario, EstadoKiosko } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Kioskos')
@Controller('kiosko')
export class KioskoController {
  constructor(private readonly kioskoService: KioskoService) {}

  /**
   * Público: la tablet en /kiosko/[tiendaId] lo llama al montar para
   * saber si hay kiosko activo antes de mostrar login.
   */
  @Public()
  @Get('tienda/:tiendaId/activo')
  @ApiOperation({ summary: 'Devuelve el kiosko activo de la tienda (público para que la tablet valide)' })
  obtenerActivoPorTienda(@Param('tiendaId', ParseIntPipe) tiendaId: number) {
    return this.kioskoService.obtenerActivoPorTienda(tiendaId);
  }

  /**
   * Público: la tablet hace ping cada 60s con su kioskoId (que ya conoce
   * desde el endpoint anterior). No requiere auth porque la "auth" del
   * kiosko es justamente saber su kioskoId activo.
   */
  @Public()
  @Post(':id/heartbeat')
  @ApiOperation({ summary: 'Heartbeat del kiosko (público)' })
  heartbeat(@Param('id', ParseIntPipe) id: number) {
    return this.kioskoService.heartbeat(id);
  }

  @Get()
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lista kioskos (Admin)' })
  listar(@Query() query: ListarKioskosQueryDto) {
    return this.kioskoService.listar({
      tiendaId: query.tiendaId,
      estado: query.estado,
    });
  }

  @Post('activar')
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Da de alta un kiosko INACTIVO para una tienda (Admin)',
    description:
      'Crea un kiosko en estado INACTIVO. Se activará automáticamente al recibir el primer ' +
      'heartbeat desde la tablet en `/kiosko/welcome?tiendaId=X`.',
  })
  activar(
    @Body() dto: ActivarKioskoDto,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.kioskoService.activar(dto, adminUserId);
  }

  @Post(':id/desactivar')
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Desactiva un kiosko (Admin)' })
  desactivar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.kioskoService.desactivar(id, adminUserId);
  }

  @Patch(':id')
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualiza nombre y/o estado de un kiosko (Admin)' })
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarKioskoDto,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.kioskoService.actualizar(id, dto, adminUserId);
  }
}
