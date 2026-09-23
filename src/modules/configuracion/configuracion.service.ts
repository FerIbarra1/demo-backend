import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../imagenes/storage.service';
import { detectarMimeImagen } from '../imagenes/validar-imagen.util';
import { LIMITE_LOGO_BYTES, CLAVE_LOGO } from './configuracion.constants';

/**
 * Configuración editable desde el panel ADMIN (tabla `configuracion_sitio`).
 *
 * Hoy solo gestiona el logo de los correos. El valor se guarda como **key de
 * storage** (`branding/logo/uuid.png`), no como URL, para que cambiar de bucket
 * o a un CDN no requiera migrar datos.
 *
 * El logo se resuelve a URL en cada lectura (no se cachea): si se cacheara en
 * `registerAs`, cambiar el logo desde el admin no surtiría efecto hasta
 * reiniciar el proceso.
 */
@Injectable()
export class ConfiguracionService {
  private readonly logger = new Logger(ConfiguracionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * URL del logo para los correos.
   *
   * Orden de resolución:
   *   1. El logo subido desde el admin (BD).
   *   2. Fallback a la env `FRONTEND_URL/Logo.png` (comportamiento anterior).
   *
   * Nunca devuelve vacío en un entorno configurado: un correo sin logo se ve
   * roto, y el fallback es barato.
   */
  async obtenerLogoUrl(): Promise<string> {
    const fila = await this.prisma.configuracionSitio.findUnique({
      where: { clave: CLAVE_LOGO },
      select: { valor: true },
    });

    if (fila?.valor) {
      const url = this.storage.resolverImagen(fila.valor);
      if (url) return url;
    }

    return this.config.get<string>('app.mail.logoUrl') ?? '';
  }

  /** Detalle del logo para el panel admin (con la key cruda). */
  async obtenerLogo() {
    const fila = await this.prisma.configuracionSitio.findUnique({
      where: { clave: CLAVE_LOGO },
    });
    return {
      // URL resuelta para el <img> del admin; null si no hay logo subido.
      url: fila?.valor ? this.storage.resolverImagen(fila.valor) : null,
      // Key de storage, para diagnóstico.
      key: fila?.valor ?? null,
      // Si no hay logo en BD, el correo usa este fallback.
      fallbackUrl: this.config.get<string>('app.mail.logoUrl') ?? '',
      actualizadoAt: fila?.updatedAt ?? null,
    };
  }

  /**
   * Sube (o reemplaza) el logo. Valida formato por firma binaria y tamaño.
   * El logo anterior se borra de S3 para no acumular huérfanos.
   */
  async subirLogo(file: Express.Multer.File) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No se recibió ningún archivo');
    }
    if (file.size > LIMITE_LOGO_BYTES) {
      throw new BadRequestException(
        `El logo supera el tamaño máximo de ${LIMITE_LOGO_BYTES / 1024 / 1024} MB`,
      );
    }

    // El mimetype lo declara el cliente: se valida el contenido real.
    const mimeReal = detectarMimeImagen(file.buffer);
    if (!mimeReal) {
      throw new BadRequestException(
        'El archivo no es una imagen válida. Usa JPG, PNG o WEBP.',
      );
    }
    file.mimetype = mimeReal;

    const anterior = await this.prisma.configuracionSitio.findUnique({
      where: { clave: CLAVE_LOGO },
      select: { valor: true },
    });

    const ext = mimeReal === 'image/png' ? '.png' : mimeReal === 'image/webp' ? '.webp' : '.jpg';
    // Key con uuid: subir un logo nuevo crea una key nueva, así el
    // Cache-Control inmutable no impide ver el cambio.
    const key = `branding/logo/${randomUUID()}${ext}`;

    const keyGuardada = await this.storage.subirImagen(file, key);

    await this.prisma.configuracionSitio.upsert({
      where: { clave: CLAVE_LOGO },
      create: { clave: CLAVE_LOGO, valor: keyGuardada },
      update: { valor: keyGuardada },
    });

    // Borrar el anterior DESPUÉS de que el nuevo esté persistido: si se
    // borrara antes y fallara el upsert, quedaríamos sin logo.
    if (anterior?.valor && anterior.valor !== keyGuardada) {
      await this.storage.eliminarImagen(anterior.valor);
    }

    return this.obtenerLogo();
  }

  /** Quita el logo de la BD. El correo vuelve al fallback de la env. */
  async eliminarLogo() {
    const fila = await this.prisma.configuracionSitio.findUnique({
      where: { clave: CLAVE_LOGO },
      select: { valor: true },
    });
    if (!fila) {
      return { mensaje: 'No había logo personalizado', ...(await this.obtenerLogo()) };
    }

    await this.prisma.configuracionSitio.delete({ where: { clave: CLAVE_LOGO } });
    await this.storage.eliminarImagen(fila.valor);

    return { mensaje: 'Logo eliminado', ...(await this.obtenerLogo()) };
  }
}
