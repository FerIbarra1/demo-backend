import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PagoTransferenciaService } from './pago-transferencia.service';
import { SubirComprobanteDto } from './dto/pago.dto';

/** Tope duro en el interceptor: busboy corta el stream antes de bufferizar un archivo enorme en RAM. */
const LIMITE_BYTES = 8 * 1024 * 1024;

/**
 * El CLIENTE y su pago por transferencia. Solo su propio pedido (404 si es de otro).
 *
 * El cliente VE sus datos y SUBE su comprobante, pero ya no elige ni cambia el método de pago
 * aquí: lo elige al hacer el pedido y, si después quiere cambiarlo, lo pide en caja (decisión del
 * dueño, oct 2026). Antes tenía "pedir datos" y "cambiar a pago en tienda".
 */
@ApiTags('Pagos - Cliente')
@Controller('cliente/pedidos')
@Roles(RolUsuario.CLIENTE)
@ApiBearerAuth()
export class PagoClienteController {
  constructor(private readonly service: PagoTransferenciaService) {}

  @Get(':id/pago')
  @ApiOperation({
    summary:
      'Estado del pago por transferencia de mi pedido + instrucciones. Siempre disponible, aunque no haya llegado el correo.',
  })
  obtener(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.service.obtenerParaCliente(id, user);
  }

  @Post(':id/pago/comprobantes')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: LIMITE_BYTES, files: 1, fields: 6 } }),
  )
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Sube el comprobante (campo `file`: JPG, PNG, WEBP o PDF, máx. 8 MB). El monto lo confirma Tesorería en el banco.',
  })
  subirComprobante(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: SubirComprobanteDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.subirComprobante(id, user, file, dto, req.ip);
  }
}
