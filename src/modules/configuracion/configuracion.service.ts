import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../imagenes/storage.service';
import { detectarMimeImagen } from '../imagenes/validar-imagen.util';
import {
  LIMITE_LOGO_BYTES,
  CLAVE_LOGO,
  CLAVE_KIOSKO_IDLE_MEDIA,
  CLAVE_KIOSKO_IDLE_TITULO,
  CLAVE_KIOSKO_IDLE_SUBTITULO,
  CLAVE_KIOSKO_IDLE_SLIDE_MS,
  PREFIJO_KIOSKO_IDLE,
  LIMITE_KIOSKO_IDLE_BYTES,
} from './configuracion.constants';

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

  // ============================================================
  // PR5 (kiosko-profesional): branding configurable desde admin.
  // Métodos genéricos sobre `configuracion_sitio` para cualquier clave.
  // Mantienen un único patrón de upsert/delete; el controller decide
  // qué hacer con el valor.
  // ============================================================

  /**
   * Lee el valor de una clave. Devuelve `null` si no existe.
   */
  async obtenerPorClave(clave: string): Promise<string | null> {
    const fila = await this.prisma.configuracionSitio.findUnique({
      where: { clave },
      select: { valor: true },
    });
    return fila?.valor ?? null;
  }

  /**
   * Upsert de una clave. Si ya existía, actualiza el valor y updatedAt.
   */
  async setPorClave(clave: string, valor: string): Promise<void> {
    await this.prisma.configuracionSitio.upsert({
      where: { clave },
      create: { clave, valor },
      update: { valor },
    });
  }

  /**
   * Elimina una clave por nombre. Idempotente: si no existe, no falla.
   */
  async eliminarPorClave(clave: string): Promise<void> {
    await this.prisma.configuracionSitio.deleteMany({ where: { clave } });
  }

  /**
   * PR5: devuelve el bundle completo de branding del kiosko para la
   * pantalla idle. Lo consume el endpoint público (sin auth) — solo
   * expone URLs públicas ya cacheables por CDN.
   */
  async obtenerBrandingKiosko(): Promise<{
    media: Array<{ url: string; key: string }>;
    titulo: string;
    subtitulo: string;
    slideMs: number;
  }> {
    const [mediaRaw, titulo, subtitulo, slideMsRaw] = await Promise.all([
      this.obtenerPorClave(CLAVE_KIOSKO_IDLE_MEDIA),
      this.obtenerPorClave(CLAVE_KIOSKO_IDLE_TITULO),
      this.obtenerPorClave(CLAVE_KIOSKO_IDLE_SUBTITULO),
      this.obtenerPorClave(CLAVE_KIOSKO_IDLE_SLIDE_MS),
    ]);

    let media: Array<{ url: string; key: string }> = [];
    if (mediaRaw) {
      try {
        const keys = JSON.parse(mediaRaw) as string[];
        media = keys
          .map((k) => ({ url: this.storage.resolverImagen(k) ?? '', key: k }))
          .filter((m) => m.url);
      } catch {
        // JSON corrupto → array vacío. La tablet verá el fallback de
        // branding (gradiente + texto).
        this.logger.warn(`kiosko_idle_media no es JSON válido: ${mediaRaw.slice(0, 80)}`);
      }
    }

    return {
      media,
      titulo: titulo ?? 'Tu pedido, en 3 toques',
      subtitulo: subtitulo ?? 'Pide desde aquí y te llamamos a mostrador cuando esté listo.',
      slideMs: slideMsRaw ? Math.max(2000, parseInt(slideMsRaw, 10) || 7000) : 7000,
    };
  }

  /**
   * PR5: sube una imagen al slideshow del kiosko. La key se añade
   * automáticamente al array `kiosko_idle_media` (y se persiste tras
   * la subida exitosa — si falla el upload, no queda una key rota).
   */
  async subirMediaKioskoImagen(file: Express.Multer.File): Promise<{ url: string; key: string }> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No se recibió ningún archivo');
    }
    if (file.size > LIMITE_KIOSKO_IDLE_BYTES) {
      throw new BadRequestException(
        `La imagen supera el tamaño máximo de ${LIMITE_KIOSKO_IDLE_BYTES / 1024 / 1024} MB`,
      );
    }
    const mimeReal = detectarMimeImagen(file.buffer);
    if (!mimeReal) {
      throw new BadRequestException(
        'El archivo no es una imagen válida. Usa JPG, PNG o WEBP.',
      );
    }
    file.mimetype = mimeReal;
    const ext = mimeReal === 'image/png' ? '.png' : mimeReal === 'image/webp' ? '.webp' : '.jpg';
    const key = `${PREFIJO_KIOSKO_IDLE}${randomUUID()}${ext}`;

    const keyGuardada = await this.storage.subirImagen(file, key);

    // Append al array existente.
    const raw = await this.obtenerPorClave(CLAVE_KIOSKO_IDLE_MEDIA);
    let arr: string[] = [];
    if (raw) {
      try {
        arr = JSON.parse(raw);
      } catch {
        arr = [];
      }
    }
    arr.push(keyGuardada);
    await this.setPorClave(CLAVE_KIOSKO_IDLE_MEDIA, JSON.stringify(arr));

    const url = this.storage.resolverImagen(keyGuardada) ?? '';
    return { url, key: keyGuardada };
  }

  /**
   * PR5: elimina una imagen del slideshow. Quita la key del array
   * persistido Y borra el archivo de S3.
   */
  async eliminarMediaKioskoImagen(key: string): Promise<void> {
    if (!key.startsWith(PREFIJO_KIOSKO_IDLE)) {
      throw new BadRequestException('Key no pertenece al kiosko');
    }
    const raw = await this.obtenerPorClave(CLAVE_KIOSKO_IDLE_MEDIA);
    if (raw) {
      let arr: string[] = [];
      try {
        arr = JSON.parse(raw);
      } catch {
        arr = [];
      }
      const nueva = arr.filter((k) => k !== key);
      await this.setPorClave(CLAVE_KIOSKO_IDLE_MEDIA, JSON.stringify(nueva));
    }
    await this.storage.eliminarImagen(key);
  }

  /**
   * PR5: actualiza el copy del kiosko (título, subtítulo, slideMs).
   * Cualquier campo undefined se ignora.
   */
  async actualizarBrandingKiosko(input: {
    titulo?: string;
    subtitulo?: string;
    slideMs?: number;
  }): Promise<void> {
    if (input.titulo !== undefined) {
      await this.setPorClave(CLAVE_KIOSKO_IDLE_TITULO, input.titulo);
    }
    if (input.subtitulo !== undefined) {
      await this.setPorClave(CLAVE_KIOSKO_IDLE_SUBTITULO, input.subtitulo);
    }
    if (input.slideMs !== undefined) {
      await this.setPorClave(CLAVE_KIOSKO_IDLE_SLIDE_MS, String(input.slideMs));
    }
  }
}
