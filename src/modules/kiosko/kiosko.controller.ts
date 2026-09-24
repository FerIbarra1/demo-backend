import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, Headers } from '@nestjs/common';
import { KioskoTokenInvalidoException } from './exceptions/kiosko-token-invalido.exception';
import { KioskoInactivoException } from './exceptions/kiosko-inactivo.exception';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KioskoService } from './kiosko.service';
import { ActivarKioskoDto } from './dto/activar-kiosko.dto';
import { ActualizarKioskoDto } from './dto/actualizar-kiosko.dto';
import { ListarKioskosQueryDto } from './dto/listar-kioskos-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
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
   * desde el endpoint anterior) Y su `X-Kiosko-Token` (device secret que
   * el admin le pegó al activarla). Sin el token, el endpoint rechaza con
   * 401 — antes bastaba con saber el kioskoId, que es SERIAL enumerable.
   *
   * Validamos dentro del service (no en un Guard) para mantener la
   * trazabilidad del flujo INACTIVO→ACTIVO en una sola transacción.
   */
  @Public()
  @Post(':id/heartbeat')
  @ApiOperation({ summary: 'Heartbeat del kiosko (público, requiere X-Kiosko-Token)' })
  @ApiHeader({ name: 'X-Kiosko-Token', required: true, description: 'Device token del kiosko (devuelto UNA vez al activarlo)' })
  // PR3: 60 req/min/IP. Suficiente para una tablet que late cada 60s +
  // overhead de reintentos al cambiar de red; corta a un atacante que
  // intenta forzar IDs en este endpoint público.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async heartbeat(
    @Param('id', ParseIntPipe) id: number,
    @Headers('x-kiosko-token') deviceToken?: string,
  ) {
    const { valido, motivo } = await this.kioskoService.validarDeviceTokenConMotivo(
      id,
      deviceToken,
    );
    if (!valido) {
      // El frontend distingue los dos casos por `codigo`:
      //  - KIOSKO_INACTIVO (409): el admin apagó el kiosko → basta reactivarlo.
      //  - KIOSKO_TOKEN_INVALIDO (401): la tablet no puede probar su
      //    identidad → el admin debe regenerar el token y pegarlo.
      // Antes ambos eran un 401 genérico y la tablet no sabía qué hacer.
      if (motivo === 'KIOSKO_INACTIVO') {
        throw new KioskoInactivoException();
      }
      throw new KioskoTokenInvalidoException();
    }
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

  /**
   * PR2 (kiosko-profesional): regenera el device token. El nuevo token
   * en claro se devuelve UNA sola vez en la respuesta. El admin debe
   * copiarlo y pegarlo en la tablet antes de cerrar el modal.
   *
   * Casos:
   *  - Kiosko legacy sin token (device_token_hash IS NULL) que necesita
   *    uno para poder mandar heartbeat.
   *  - Tablet comprometida/robada: el admin invalida el anterior y la
   *    tablet atacante queda bloqueada en el siguiente heartbeat.
   */
  @Post(':id/regenerar-token')
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Regenera el device token del kiosko (Admin). Devuelve el token en claro UNA vez.',
  })
  async regenerarToken(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.kioskoService.regenerarDeviceToken(id, adminUserId);
  }
}
