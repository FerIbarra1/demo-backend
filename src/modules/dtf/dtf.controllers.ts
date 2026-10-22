import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DTF_MAX_BYTES } from '../../config/app.config';
import { DtfMovilGuard } from './dtf-movil.guard';
import { UserContext } from '../../types/pedido.types';
import { DtfConfigService } from './dtf-config.service';
import { DtfTrabajoService } from './dtf-trabajo.service';
import { ImpresionService, TabCola } from './impresion.service';

/**
 * Multer a DISCO (nunca a memoria): un PDF de DTF pesa decenas o cientos de MB. El tope es el MISMO que valida
 * `subirArchivo` (`DTF_MAX_BYTES`, una sola constante): con dos copias, bajar una dejaba a Multer escribiendo hasta
 * el tope viejo antes de que el servicio rechazara por tamaño.
 */
const subida = () =>
  FileInterceptor('file', {
    storage: diskStorage({ destination: tmpdir() }),
    limits: { fileSize: DTF_MAX_BYTES, files: 1, fields: 6 },
  });

function enviarArchivo(
  res: Response,
  a: { stream: NodeJS.ReadableStream; bytes?: number; mime: string; nombre: string },
  adjunto: boolean,
) {
  res.setHeader('Content-Type', a.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader(
    'Content-Disposition',
    `${adjunto ? 'attachment' : 'inline'}; filename="${a.nombre}"`,
  );
  if (a.bytes) res.setHeader('Content-Length', String(a.bytes));
  a.stream.pipe(res);
}
const tiendaDe = (u: UserContext, header?: string) => {
  const h = header ? Number(header) : NaN;
  return (Number.isInteger(h) && h > 0 ? h : u.tiendaId) as number;
};

// ───────────────────────────── público ─────────────────────────────

@ApiTags('DTF')
@Controller('dtf')
export class DtfPublicoController {
  constructor(
    private readonly cfg: DtfConfigService,
    private readonly trabajos: DtfTrabajoService,
  ) {}

  /** La landing: tipos, reglas y qué tiendas imprimen, con el precio base (lista 1). */
  @Public()
  @Get('publico')
  publico() {
    return this.cfg.publico();
  }

  /** Página de subida del celular: el token es la autorización (un solo borrador, minutos). */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('movil/:token')
  infoMovil(@Param('token') token: string) {
    return this.trabajos.infoMovil(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('movil/:token/archivo')
  @UseGuards(DtfMovilGuard)
  @UseInterceptors(subida())
  async subirDesdeMovil(@Param('token') token: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file").');
    const actor = this.trabajos.actorMovil(token);
    const r = await this.trabajos.subirArchivo(
      (actor as { trabajoId: number }).trabajoId,
      actor,
      { path: file.path, originalname: file.originalname, size: file.size },
      'CELULAR_QR',
    );
    return {
      duplicado: r.duplicado,
      estado: r.trabajo.archivo?.preflightEstado ?? 'PENDIENTE',
      reglas: r.trabajo.archivo?.reglas ?? [],
      cotizacion: r.trabajo.cotizacion,
    };
  }
}

// ───────────────────────────── cliente ─────────────────────────────

@ApiTags('DTF')
@ApiBearerAuth()
@Roles(RolUsuario.CLIENTE)
@Controller('dtf')
export class DtfClienteController {
  constructor(
    private readonly cfg: DtfConfigService,
    private readonly trabajos: DtfTrabajoService,
  ) {}

  @Get('tipos')
  tipos(@CurrentUser() u: UserContext, @Headers('x-tienda-id') h?: string) {
    return this.cfg.tiposDeTienda(tiendaDe(u, h), u.userId);
  }

  @Get('borradores')
  borradores(@CurrentUser() u: UserContext, @Headers('x-tienda-id') h?: string) {
    return this.trabajos.misBorradores(u, tiendaDe(u, h));
  }

  @Post('borradores')
  crear(
    @CurrentUser() u: UserContext,
    @Headers('x-tienda-id') h: string | undefined,
    @Body() dto: { tipoId: number; nombre: string; copias?: number; notaCliente?: string },
  ) {
    return this.trabajos.crearBorrador(u, tiendaDe(u, h), dto);
  }

  @Get('trabajos/:id')
  uno(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.trabajos.vistaCliente(id, u);
  }

  @Patch('trabajos/:id')
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { nombre?: string; copias?: number; notaCliente?: string; aceptoRiesgo?: boolean },
  ) {
    return this.trabajos.actualizar(id, u, dto);
  }

  @Delete('trabajos/:id')
  cancelar(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.trabajos.cancelar(id, u);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('trabajos/:id/archivo')
  @UseInterceptors(subida())
  async subir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file").');
    return this.trabajos.subirArchivo(
      id,
      { tipo: 'USUARIO', user: u },
      { path: file.path, originalname: file.originalname, size: file.size },
      'WEB',
    );
  }

  /** El QR de "sube desde tu celular" (tablet del kiosko o web de escritorio). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('trabajos/:id/enlace-subida')
  async enlace(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    await this.trabajos.vistaCliente(id, u); // valida que sea suyo
    return this.trabajos.enlaceSubida(id, u.userId);
  }

  @Get('trabajos/:id/preview')
  async preview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Res() res: Response,
    @Query('version') v?: string,
  ) {
    enviarArchivo(
      res,
      await this.trabajos.archivoParaDescargar(id, v ? Number(v) : null, u, true),
      false,
    );
  }

  @Get('trabajos/:id/mensajes')
  mensajes(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.trabajos.mensajes(id, u);
  }

  @Post('trabajos/:id/mensajes')
  escribir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { contenido: string },
  ) {
    return this.trabajos.escribir(id, u, dto.contenido);
  }
}

// ───────────────────────────── Impresión ─────────────────────────────

@ApiTags('Impresión DTF')
@ApiBearerAuth()
@Roles(RolUsuario.IMPRESION, RolUsuario.ADMIN)
@Controller('impresion')
export class ImpresionController {
  constructor(
    private readonly svc: ImpresionService,
    private readonly trabajos: DtfTrabajoService,
  ) {}

  @Get('resumen')
  resumen(@CurrentUser() u: UserContext, @Query('tiendaId') t?: string) {
    return this.svc.resumen(u, t ? Number(t) : undefined);
  }

  @Get('cola')
  cola(
    @CurrentUser() u: UserContext,
    @Query('tab') tab?: TabCola,
    @Query('tecnologia') tec?: string,
    @Query('q') q?: string,
    @Query('tiendaId') t?: string,
  ) {
    return this.svc.cola(u, { tab, tecnologia: tec, q, tiendaId: t ? Number(t) : undefined });
  }

  @Get('hoja')
  hoja(
    @CurrentUser() u: UserContext,
    @Query('fecha') fecha?: string,
    @Query('tiendaId') t?: string,
  ) {
    return this.svc.hoja(u, { fecha, tiendaId: t ? Number(t) : undefined });
  }

  @Get('hoja.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async hojaCsv(
    @CurrentUser() u: UserContext,
    @Res() res: Response,
    @Query('fecha') fecha?: string,
    @Query('tiendaId') t?: string,
  ) {
    const r = await this.svc.hojaCsv(u, { fecha, tiendaId: t ? Number(t) : undefined });
    res.setHeader('Content-Disposition', `attachment; filename="${r.nombre}"`);
    res.send(r.contenido);
  }

  @Post('lote/impreso')
  lote(@CurrentUser() u: UserContext, @Body() dto: { ids: number[] }) {
    return this.svc.loteImpreso(
      Array.isArray(dto.ids) ? dto.ids.map(Number).filter(Number.isInteger) : [],
      u,
    );
  }

  @Get(':id')
  detalle(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.svc.detalle(u, id);
  }

  @Post(':id/tomar') tomar(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.svc.tomar(id, u);
  }
  @Post(':id/soltar') soltar(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: UserContext) {
    return this.svc.soltar(id, u);
  }
  @Post(':id/aprobar') aprobar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { planoBlanco?: boolean; nota?: string },
  ) {
    return this.svc.aprobar(id, u, dto ?? {});
  }
  @Post(':id/pedir-correccion') corregir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { motivos?: string[]; nota?: string },
  ) {
    return this.svc.pedirCorreccion(id, u, dto ?? {});
  }
  @Post(':id/rechazar') rechazar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { motivo: string; nota?: string },
  ) {
    return this.svc.rechazar(id, u, dto);
  }
  @Post(':id/imprimir') imprimir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
  ) {
    return this.svc.imprimir(id, u);
  }
  @Post(':id/impreso') impreso(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
  ) {
    return this.svc.marcarImpreso(id, u);
  }
  @Post(':id/reimprimir') reimprimir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { motivo: string; nota?: string },
  ) {
    return this.svc.reimprimir(id, u, dto);
  }
  @Patch(':id/medidas') medidas(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { altoCm: number },
  ) {
    return this.svc.ajustarMedidas(id, u, Number(dto.altoCm));
  }
  @Patch(':id/hora-estimada') hora(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { hora: string | null },
  ) {
    return this.svc.horaEstimada(id, u, dto.hora ?? null);
  }

  /** Asistido: el personal sube el archivo EN NOMBRE del cliente (USB, correo, WhatsApp). */
  @Post(':id/archivo')
  @UseInterceptors(subida())
  async adjuntar(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Falta el archivo (campo "file").');
    await this.trabajos.subirArchivo(
      id,
      { tipo: 'USUARIO', user: u },
      { path: file.path, originalname: file.originalname, size: file.size },
      'ASISTIDO',
    );
    return this.svc.detalle(u, id);
  }

  @Get(':id/original')
  async original(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Res() res: Response,
    @Query('version') v?: string,
  ) {
    enviarArchivo(
      res,
      await this.trabajos.archivoParaDescargar(id, v ? Number(v) : null, u, false),
      true,
    );
  }

  @Get(':id/preview')
  async preview(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Res() res: Response,
    @Query('version') v?: string,
  ) {
    enviarArchivo(
      res,
      await this.trabajos.archivoParaDescargar(id, v ? Number(v) : null, u, true),
      false,
    );
  }

  @Get(':id/mensajes') mensajes(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
  ) {
    return this.trabajos.mensajes(id, u);
  }
  @Post(':id/mensajes') escribir(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: UserContext,
    @Body() dto: { contenido: string },
  ) {
    return this.trabajos.escribir(id, u, dto.contenido);
  }
}

// ───────────────────────────── admin ─────────────────────────────

@ApiTags('Admin - DTF')
@ApiBearerAuth()
@Roles(RolUsuario.ADMIN)
@Controller('admin/dtf')
export class DtfAdminController {
  constructor(private readonly cfg: DtfConfigService) {}

  @Get() listar() {
    return this.cfg.adminListar();
  }
  @Patch('tipos/:id') tipo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.cfg.adminActualizarTipo(id, dto);
  }
  @Patch('tiendas/:tiendaId/tipos/:tipoId') tienda(
    @Param('tiendaId', ParseIntPipe) tiendaId: number,
    @Param('tipoId', ParseIntPipe) tipoId: number,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.cfg.adminGuardarTienda(tiendaId, tipoId, dto);
  }
}
