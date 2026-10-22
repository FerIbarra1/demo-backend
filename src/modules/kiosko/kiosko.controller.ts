import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  Query,
  Headers,
} from '@nestjs/common';
import { KioskoTokenInvalidoException } from './exceptions/kiosko-token-invalido.exception';
import { KioskoInactivoException } from './exceptions/kiosko-inactivo.exception';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KioskoService } from './kiosko.service';
import { CrearKioskoDto } from './dto/crear-kiosko.dto';
import { ActualizarKioskoDto } from './dto/actualizar-kiosko.dto';
import { ListarKioskosQueryDto } from './dto/listar-kioskos-query.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import type { UserContext } from '../../types/pedido.types';

/**
 * Kioskos. El ADMIN opera los de cualquier tienda; el GERENTE solo los de la SUYA (la tienda sale de su token y el
 * servicio rechaza —404— cualquier kiosko de otra: ver `KioskoService.cargarParaActor`). Lo fija
 * `kiosko.service.spec.ts` y la lista cerrada de `roles-contrato.spec.ts`.
 */
@ApiTags('Kioskos')
@Controller('kiosko')
export class KioskoController {
  constructor(private readonly kioskoService: KioskoService) {}

  /**
   * Público: la tablet hace ping cada 60s con su kioskoId Y su `X-Kiosko-Token` (el device secret que recibió al
   * emparejarse). Sin el token, 401: el kioskoId es SERIAL y enumerable. Responde además quién es la tablet según
   * el servidor (nombre y tienda): ver `KioskoService.respuestaHeartbeat`.
   */
  @Public()
  @Post(':id/heartbeat')
  @ApiOperation({ summary: 'Heartbeat del kiosko (público, requiere X-Kiosko-Token)' })
  @ApiHeader({
    name: 'X-Kiosko-Token',
    required: true,
    description: 'Device token del kiosko (se entrega UNA vez, al emparejar la tablet)',
  })
  // 60 req/min/IP. Suficiente para una tablet que late cada 60s + reintentos al cambiar de red; corta a quien
  // intenta forzar ids en este endpoint público.
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
      // La tablet distingue los dos casos por `codigo`:
      //  - KIOSKO_INACTIVO (409): se apagó el kiosko → basta reactivarlo.
      //  - KIOSKO_TOKEN_INVALIDO (401): la tablet no puede probar su identidad → pide emparejarse sola.
      if (motivo === 'KIOSKO_INACTIVO') throw new KioskoInactivoException();
      throw new KioskoTokenInvalidoException();
    }
    return this.kioskoService.heartbeat(id);
  }

  @Get()
  @Roles(RolUsuario.ADMIN, RolUsuario.GERENTE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lista kioskos con su salud (el gerente, solo los de su tienda)' })
  listar(@Query() query: ListarKioskosQueryDto, @CurrentUser() user: UserContext) {
    return this.kioskoService.listar(user, { tiendaId: query.tiendaId, estado: query.estado });
  }

  @Post()
  @Roles(RolUsuario.ADMIN, RolUsuario.GERENTE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Da de alta un kiosko (el sistema le pone el nombre)',
    description:
      'Queda ACTIVO y sin tablet ("pendiente de instalar"). La tablet abre `/kiosko`, muestra un código y se ' +
      'vincula desde el panel (`kiosko/pairing`).',
  })
  crear(@Body() dto: CrearKioskoDto, @CurrentUser() user: UserContext) {
    return this.kioskoService.crear(user, dto);
  }

  @Patch(':id')
  @Roles(RolUsuario.ADMIN, RolUsuario.GERENTE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambia la ubicación y/o activa o desactiva un kiosko' })
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarKioskoDto,
    @CurrentUser() user: UserContext,
  ) {
    return this.kioskoService.actualizar(id, dto, user);
  }

  @Post(':id/desvincular')
  @Roles(RolUsuario.ADMIN, RolUsuario.GERENTE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Quita la tablet de un kiosko (robada, reemplazada o desconfigurada)',
    description:
      'Borra el token: la tablet pierde acceso al instante y vuelve sola a pedir emparejamiento. ' +
      'El kiosko y sus pedidos se conservan.',
  })
  desvincular(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: UserContext) {
    return this.kioskoService.desvincular(id, user);
  }
}
