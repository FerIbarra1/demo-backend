import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { ConfiguracionService } from './configuracion.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { LIMITE_LOGO_BYTES, LIMITE_KIOSKO_IDLE_BYTES } from './configuracion.constants';

@ApiTags('Configuración del sitio (Admin)')
@ApiBearerAuth()
@Controller('admin/configuracion')
@Roles(RolUsuario.ADMIN)
export class ConfiguracionController {
  constructor(private readonly configuracion: ConfiguracionService) {}

  @Get('logo')
  @ApiOperation({
    summary: 'Logo actual de los correos (Admin)',
    description:
      'Devuelve la URL resuelta, la key de storage y el fallback de la env.',
  })
  obtenerLogo() {
    return this.configuracion.obtenerLogo();
  }

  @Post('logo')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Sube o reemplaza el logo de los correos (Admin)',
    description: 'Campo multipart `file` (JPG/PNG/WEBP, máx 2 MB).',
  })
  // Límite en el interceptor: sin él, memoryStorage bufferiza el archivo
  // completo en RAM antes de que el service pueda validar los 2 MB.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LIMITE_LOGO_BYTES, files: 1, fields: 2 },
    }),
  )
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  subirLogo(@UploadedFile() file: Express.Multer.File) {
    return this.configuracion.subirLogo(file);
  }

  @Delete('logo')
  @ApiOperation({
    summary: 'Elimina el logo personalizado (Admin)',
    description: 'El correo vuelve al logo por defecto de la configuración.',
  })
  eliminarLogo() {
    return this.configuracion.eliminarLogo();
  }

  // ============================================================
  // PR5 (kiosko-profesional): branding del kiosko desde admin.
  // Imágenes del slideshow + copy. Las imágenes viven en S3 con prefijo
  // kiosko/idle/, las claves se persisten como JSON array en
  // configuracion_sitio.valor con clave kiosko_idle_media.
  // ============================================================

  @Put('kiosko')
  @ApiOperation({
    summary: 'Actualiza el copy del kiosko (título, subtítulo, slideMs, appDownloadUrl)',
  })
  actualizarBrandingKiosko(
    @Body() body: {
      titulo?: string;
      subtitulo?: string;
      slideMs?: number;
      appDownloadUrl?: string;
    },
  ) {
    return this.configuracion
      .actualizarBrandingKiosko(body)
      .then(() => this.configuracion.obtenerBrandingKiosko());
  }

  @Post('kiosko/media')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Sube una imagen al slideshow del kiosko (JPG/PNG/WEBP, máx 5 MB)',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LIMITE_KIOSKO_IDLE_BYTES, files: 1, fields: 2 },
    }),
  )
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async subirMediaKiosko(@UploadedFile() file: Express.Multer.File) {
    return this.configuracion.subirMediaKioskoImagen(file);
  }

  @Delete('kiosko/media/:key')
  @ApiOperation({ summary: 'Elimina una imagen del slideshow del kiosko' })
  async eliminarMediaKiosko(@Body() body: { key: string }) {
    await this.configuracion.eliminarMediaKioskoImagen(body.key);
    return { ok: true };
  }
}

// ============================================================
// PR5: endpoint PÚBLICO que consume la pantalla IDLE del kiosko.
// Sin auth — solo expone URLs públicas ya cacheables por CDN.
// ============================================================

@ApiTags('Configuración del sitio (público)')
@Controller('configuracion')
export class ConfiguracionPublicController {
  constructor(private readonly configuracion: ConfiguracionService) {}

  @Public()
  @Get('kiosko')
  @ApiOperation({
    summary: 'Branding público del kiosko (idle screen)',
    description: 'Público. Lo consume /kiosko/idle en cada montaje.',
  })
  // PR5: limit alto porque la tablet puede llamar en cada reload. Pero
  // no queremos abuso: 120 req/min/IP es generoso y corta a un script.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  brandingKiosko() {
    return this.configuracion.obtenerBrandingKiosko();
  }
}
