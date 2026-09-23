import {
  Controller,
  Get,
  Post,
  Delete,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { ConfiguracionService } from './configuracion.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { LIMITE_LOGO_BYTES } from './configuracion.constants';

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
}
