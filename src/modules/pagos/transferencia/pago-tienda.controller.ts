import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PagoTransferenciaService } from './pago-transferencia.service';
import { EstacionGuard, RequiereEstacion } from '../../../common/guards/estacion.guard';
import { SubirComprobanteDto } from './dto/pago.dto';

/** Tope duro en el interceptor: busboy corta el stream antes de bufferizar un archivo enorme en RAM. */
const LIMITE_BYTES = 8 * 1024 * 1024;

/**
 * CAJA ve qué hacer con el cobro de un pedido de SU tienda (la tienda sale del JWT) y, si el
 * cliente lo pide, le cambia la forma de pago.
 *
 * Solo CAJERO (y ADMIN, que pasa siempre): MOSTRADOR revisa el pedido con el cliente y lo MANDA A
 * PAGAR, y hasta ahí (decisión del dueño, oct 2026). Antes también podía dar los datos de
 * transferencia y pasar al cliente a pagar en caja: el método de pago es cosa de caja.
 *
 * Caja también SUBE EL COMPROBANTE en nombre del cliente (foto con la tablet), para el que no tiene
 * internet, no sabe hacerlo, o va de mandadero. Solo CAJERO (decisión del dueño, 16-oct). No verifica:
 * el pago pasa a revisión y Tesorería lo resuelve.
 */
@ApiTags('Pagos - Tienda')
@UseGuards(EstacionGuard)
@Controller('pedidos/:pedidoId/pago-transferencia')
@Roles(RolUsuario.CAJERO)
@ApiBearerAuth()
export class PagoTiendaController {
  constructor(private readonly service: PagoTransferenciaService) {}

  @Get()
  @ApiOperation({
    summary:
      'Estado de la transferencia de un pedido y la instrucción para caja ("no cobres" / "registra en VFP como TRANSFERENCIA").',
  })
  resumen(@Param('pedidoId', ParseIntPipe) pedidoId: number, @CurrentUser() user: any) {
    return this.service.resumenParaTienda(pedidoId, user);
  }

  @Post('enviar-datos')
  @RequiereEstacion()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'El cliente quiere transferir: se le dan los datos (y le llegan por correo). Idempotente.',
  })
  enviarDatos(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.emitirInstrucciones(pedidoId, user, req.ip);
  }

  @Post('comprobantes')
  @RequiereEstacion()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: LIMITE_BYTES, files: 1, fields: 6 } }),
  )
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Caja sube el comprobante EN NOMBRE del cliente (campo `file`: JPG, PNG, WEBP o PDF, máx. 8 MB). ' +
      'No verifica nada: el pago pasa a EN_REVISION y Tesorería lo resuelve. Queda anotado quién lo subió.',
  })
  subirComprobante(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: SubirComprobanteDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.subirComprobante(pedidoId, user, file, dto, req.ip);
  }

  @Post('cambiar-a-tienda')
  @RequiereEstacion()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'El cliente prefiere pagar en caja. Solo si aún no envió comprobante (409 si ya hay dinero en juego).',
  })
  cambiarATienda(
    @Param('pedidoId', ParseIntPipe) pedidoId: number,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.cambiarATienda(pedidoId, user, req.ip);
  }
}
