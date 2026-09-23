import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { KioskoPairingService } from './kiosko-pairing.service';
import {
  SolicitarPairingDto,
  ReclamarPairingDto,
  AprobarPairingDto,
  BuscarPairingQueryDto,
} from './dto/pairing.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Emparejamiento de tablets con kioskos.
 *
 * Los dos primeros endpoints son PÚBLICOS porque los llama la tablet cuando
 * NO tiene credencial (es justo el caso que resuelven). Su seguridad no
 * depende de estar autenticado, sino de que el reclamo exija el `deviceSecret`
 * que sólo la tablet física tiene en memoria.
 *
 * Los dos últimos son del admin: es él quien correlaciona el código y autoriza.
 */
@ApiTags('Kioskos')
@Controller('kiosko/pairing')
export class KioskoPairingController {
  constructor(private readonly pairing: KioskoPairingService) {}

  /**
   * La tablet (sin credencial) pide emparejarse. Devuelve el código que debe
   * mostrar en pantalla. Throttle estricto: es un endpoint público que crea
   * filas.
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post()
  @ApiOperation({ summary: 'Solicita emparejamiento (público: la tablet no tiene credencial)' })
  async solicitar(@Body() dto: SolicitarPairingDto, @Req() req: Request) {
    await this.pairing.purgarVencidas();
    const ip = (req.ip as string | undefined) ?? req.socket?.remoteAddress;
    return this.pairing.solicitar({
      deviceSecretHash: dto.deviceSecretHash,
      tiendaIdHint: dto.tiendaIdHint,
      kioskoIdHint: dto.kioskoIdHint,
      ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * La tablet reclama el token una vez que el admin autorizó. Exige el
   * `deviceSecret`; sin él, conocer el `pairingId` no alcanza.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':pairingId/reclamar')
  @ApiOperation({ summary: 'Reclama el device token (público, exige deviceSecret)' })
  reclamar(@Param('pairingId') pairingId: string, @Body() dto: ReclamarPairingDto) {
    return this.pairing.reclamar(pairingId, dto.deviceSecret);
  }

  /** El admin busca la solicitud por el código que le leyó el encargado. */
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('lookup')
  @ApiOperation({ summary: 'Busca una solicitud por código (Admin)' })
  buscar(@Query() query: BuscarPairingQueryDto) {
    return this.pairing.buscarPorCodigo(query.code);
  }

  /** El admin autoriza: elige a qué kiosko se vincula esta tablet. */
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @Post(':pairingId/aprobar')
  @ApiOperation({ summary: 'Autoriza la vinculación de la tablet a un kiosko (Admin)' })
  aprobar(
    @Param('pairingId') pairingId: string,
    @Body() dto: AprobarPairingDto,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.pairing.aprobar(pairingId, dto.kioskoId, adminUserId);
  }

  /** El admin cancela una solicitud (p. ej. no reconoce la tablet). */
  @Roles(RolUsuario.ADMIN)
  @ApiBearerAuth()
  @Post(':pairingId/cancelar')
  @ApiOperation({ summary: 'Cancela una solicitud de emparejamiento (Admin)' })
  cancelar(
    @Param('pairingId') pairingId: string,
    @CurrentUser('userId') adminUserId: number,
  ) {
    return this.pairing.cancelar(pairingId, adminUserId);
  }
}
