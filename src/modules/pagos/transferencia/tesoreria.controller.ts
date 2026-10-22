import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { TesoreriaService } from './tesoreria.service';
import {
  AbonoSinPedidoDto,
  AprobarPagoDto,
  ConciliacionQueryDto,
  ListarPagosQueryDto,
  RechazarPagoDto,
  RegistrarReembolsoDto,
  ReenviarInstruccionesDto,
  ResolverRevisionDto,
  VencerPagoDto,
} from './dto/pago.dto';

/**
 * Consola de TESORERÍA: pagos por transferencia de TODAS las tiendas. ADMIN también entra
 * (supervisa; cada acción queda con su nombre en la bitácora).
 *
 * Las rutas fijas (`resumen`, `comprobantes/…`) van ANTES de `:id`, o `:id` las capturaría.
 */
@ApiTags('Pagos - Tesorería')
@Controller('tesoreria/pagos')
@Roles(RolUsuario.TESORERIA)
@ApiBearerAuth()
export class TesoreriaController {
  constructor(private readonly service: TesoreriaService) {}

  @Get('resumen')
  @ApiOperation({
    summary: 'Contadores: por revisar, esperando, verificados, reembolsos, por aclarar',
  })
  resumen() {
    return this.service.resumen();
  }

  @Get('conciliacion')
  @ApiOperation({
    summary:
      'Reporte para cruzar contra el corte de caja de VFP: pagos verificados en un rango de días del negocio, con totales',
  })
  conciliacion(@Query() query: ConciliacionQueryDto) {
    return this.service.conciliacion(query);
  }

  @Get('conciliacion/csv')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'El mismo reporte como CSV (UTF-8 con BOM, para Excel)' })
  async conciliacionCsv(
    @Query() query: ConciliacionQueryDto,
    @Res({ passthrough: true }) res: { set: (h: Record<string, string>) => void },
  ) {
    const { csv, nombre } = await this.service.conciliacionCsv(query);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nombre}"`,
    });
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Get('comprobantes/:comprobanteId/archivo')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'El archivo del comprobante (stream autorizado; cada vista queda en la bitácora)',
  })
  async archivo(
    @Param('comprobanteId', ParseIntPipe) comprobanteId: number,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    const { stream, mime, bytes } = await this.service.archivo(comprobanteId, user, req.ip);
    return new StreamableFile(stream, {
      type: mime,
      length: bytes,
      disposition: 'inline',
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Cola de pagos por grupo, con búsqueda (folio, referencia, cliente, teléfono, monto…)',
  })
  listar(@Query() query: ListarPagosQueryDto) {
    return this.service.listar(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle: pedido, cliente (teléfono y correo), comprobantes, advertencias y bitácora',
  })
  detalle(@Param('id', ParseIntPipe) id: number) {
    return this.service.detalle(id);
  }

  @Get(':id/instrucciones')
  @ApiOperation({
    summary: 'Las instrucciones tal cual las recibe el cliente (texto listo para copiar)',
  })
  instrucciones(@Param('id', ParseIntPipe) id: number) {
    return this.service.instrucciones(id);
  }

  @Post(':id/reenviar-instrucciones')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: '"No me llegó el correo": reenvía las instrucciones (opcionalmente a otro correo)',
  })
  reenviar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReenviarInstruccionesDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.reenviarInstrucciones(id, dto, user, req.ip);
  }

  @Post(':id/aprobar')
  @ApiOperation({
    summary:
      'Verifica que el abono llegó al banco (monto EXACTO). No marca pagado: eso lo hace VFP.',
  })
  aprobar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AprobarPagoDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.aprobar(id, dto, user, req.ip);
  }

  @Post(':id/vencer')
  @ApiOperation({
    summary:
      'Marca vencidas unas instrucciones sin comprobante (manual, sin plazo; con motivo). Un abono posterior se verifica igual.',
  })
  vencer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VencerPagoDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.vencer(id, dto.motivo, user, req.ip);
  }

  @Post(':id/rechazar')
  @ApiOperation({ summary: 'Rechaza el comprobante con su motivo; el cliente puede subir otro' })
  rechazar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RechazarPagoDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.rechazar(id, dto, user, req.ip);
  }

  @Post(':id/abono-sin-pedido')
  @ApiOperation({
    summary:
      'Llegó dinero y el pedido ya no está pendiente de pago: queda como reembolso pendiente',
  })
  abonoSinPedido(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AbonoSinPedidoDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.abonoSinPedido(id, dto, user, req.ip);
  }

  @Post(':id/registrar-reembolso')
  @ApiOperation({ summary: 'Se devolvió el dinero al cliente' })
  reembolso(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RegistrarReembolsoDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.registrarReembolso(id, dto, user, req.ip);
  }

  @Post(':id/resolver-revision')
  @ApiOperation({
    summary: 'Se aclaró lo que tenía bloqueado el pago (p. ej. el total que cambió en VFP)',
  })
  resolverRevision(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolverRevisionDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.service.resolverRevision(id, dto, user, req.ip);
  }
}
