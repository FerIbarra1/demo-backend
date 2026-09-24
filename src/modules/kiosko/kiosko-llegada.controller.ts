import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Param,
  ParseIntPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KioskoLlegadaService } from './kiosko-llegada.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * PR7 (kiosko-profesional): endpoints del flujo "avisar llegada".
 *
 * - /kiosko/llegada/consultar y /kiosko/llegada/confirmar: PÚBLICOS,
 *   desde la tablet del kiosko. Requieren X-Kiosko-Id + X-Kiosko-Token
 *   (validado en el service).
 * - /pedidos/:id/qr-llegada: autenticado (cliente dueño o admin).
 *   Devuelve el token QR firmado para mostrar en la app / email.
 */
@ApiTags('Kiosko - Avisar llegada')
@Controller()
export class KioskoLlegadaController {
  constructor(
    private readonly service: KioskoLlegadaService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('kiosko/llegada/consultar')
  @ApiOperation({
    summary: 'Consulta un pedido por QR o folio (no escribe nada)',
    description: 'Público. La tablet llama antes de confirmar para mostrar "¿es este tu pedido?".',
  })
  @ApiHeader({ name: 'X-Kiosko-Id', required: true })
  @ApiHeader({ name: 'X-Kiosko-Token', required: true })
  @ApiHeader({ name: 'X-Tienda-Id', required: true })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  consultar(
    @Body() body: { qr?: string; folio?: string },
    @Headers('x-kiosko-id') kioskoIdHeader?: string,
    @Headers('x-kiosko-token') deviceToken?: string,
    @Headers('x-tienda-id') tiendaIdHeader?: string,
  ) {
    const kioskoId = parseInt(kioskoIdHeader ?? '', 10);
    const tiendaId = parseInt(tiendaIdHeader ?? '', 10);
    if (!Number.isFinite(kioskoId) || !Number.isFinite(tiendaId) || !deviceToken) {
      throw new UnauthorizedException('Faltan headers requeridos');
    }
    return this.service.consultar({
      kioskoId,
      kioskoTiendaId: tiendaId,
      deviceToken,
      qr: body?.qr,
      folio: body?.folio,
    });
  }

  @Public()
  @Post('kiosko/llegada/confirmar')
  @ApiOperation({
    summary: 'Confirma el aviso de llegada (escribe y emite realtime)',
    description: 'Público. La tablet confirma tras "¿es este tu pedido?".',
  })
  @ApiHeader({ name: 'X-Kiosko-Id', required: true })
  @ApiHeader({ name: 'X-Kiosko-Token', required: true })
  @ApiHeader({ name: 'X-Tienda-Id', required: true })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmar(
    @Body() body: { qr?: string; folio?: string },
    @Headers('x-kiosko-id') kioskoIdHeader?: string,
    @Headers('x-kiosko-token') deviceToken?: string,
    @Headers('x-tienda-id') tiendaIdHeader?: string,
  ) {
    const kioskoId = parseInt(kioskoIdHeader ?? '', 10);
    const tiendaId = parseInt(tiendaIdHeader ?? '', 10);
    if (!Number.isFinite(kioskoId) || !Number.isFinite(tiendaId) || !deviceToken) {
      throw new UnauthorizedException('Faltan headers requeridos');
    }
    // Obtenemos el nombre del kiosko para el snapshot `llegadaAnunciadaPor`.
    const kiosko = await this.prisma.kiosko.findUnique({
      where: { id: kioskoId },
      select: { nombre: true },
    });
    return this.service.confirmar({
      kioskoId,
      kioskoTiendaId: tiendaId,
      kioskoNombre: kiosko?.nombre ?? 'Kiosko',
      deviceToken,
      qr: body?.qr,
      folio: body?.folio,
    });
  }
}

/**
 * PR7: endpoint autenticado para que web/app genere el QR firmado que
 * mostrará al cliente (en /perfil o en el email de "listo para pagar").
 */
@ApiTags('Pedidos - QR de llegada')
@ApiBearerAuth()
@Controller('pedidos')
export class PedidoLlegoQrController {
  constructor(
    private readonly service: KioskoLlegadaService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/qr-llegada')
  @Roles(RolUsuario.CLIENTE, RolUsuario.ADMIN, RolUsuario.MOSTRADOR)
  @ApiOperation({
    summary: 'Genera el QR firmado HMAC para avisar llegada a tienda',
  })
  async generarQr(
    @Param('id', ParseIntPipe) pedidoId: number,
    @CurrentUser() user: any,
  ) {
    // Validación: el cliente solo puede pedir el QR de SU pedido.
    // ADMIN/MOSTRADOR pueden pedir cualquiera.
    //
    // F16 (sep 2026): antes la condición era
    // `user.rol === CLIENTE && user.userId !== undefined`. Si `userId` llegaba
    // `undefined` (token sin el claim), la condición completa era `false` y se
    // SALTABA la validación de dueño: un CLIENTE autenticado podía obtener el
    // QR firmado de cualquier pedido. Ese QR es la credencial para anunciar
    // llegada, así que el bypass permitía hacer aparecer el pedido de otro en
    // la cola del mostrador. Ahora se exige el userId y se falla cerrado.
    if (user.rol === RolUsuario.CLIENTE) {
      if (user.userId === undefined || user.userId === null) {
        throw new UnauthorizedException('No autorizado');
      }
      const pedido = await this.prisma.pedido.findUnique({
        where: { id: pedidoId },
        select: { usuarioId: true },
      });
      if (!pedido || pedido.usuarioId !== user.userId) {
        throw new UnauthorizedException('No autorizado');
      }
    }
    return this.service.generarQrParaPedido(pedidoId);
  }
}