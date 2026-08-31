import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdir, writeFile, unlink } from 'fs/promises';

/**
 * StorageService: sube y elimina imágenes de producto.
 *
 * Si hay credenciales AWS configuradas (app.s3.accessKeyId), sube a S3 y
 * devuelve una URL pública. Si no hay credenciales (dev sin AWS), cae a
 * disco local bajo `uploads/` (servido por main.ts en `/files/`) para que
 * el desarrollo funcione. La URL guardada en BD es siempre la que devuelve
 * `subirImagen`, lista para usarse en el frontend.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicUrlBase: string;

  constructor(private readonly config: ConfigService) {
    const s3Config = this.config.get('app.s3') || {};
    this.bucket = s3Config.bucket || '';
    this.region = s3Config.region || 'us-east-1';
    this.publicUrlBase = s3Config.publicUrlBase || '';
    const accessKeyId = s3Config.accessKeyId || '';
    const secretAccessKey = s3Config.secretAccessKey || '';

    // Sólo instanciar S3 si hay credenciales. Sin ellas → disco local.
    this.s3 =
      accessKeyId && secretAccessKey
        ? new S3Client({
            region: this.region,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
  }

  get usaS3(): boolean {
    return this.s3 !== null;
  }

  /**
   * Sube un archivo y devuelve la URL pública que se persistirá en BD.
   * `key` debe ser único por imagen (p.ej. productos/1/color/3/uuid.jpg).
   */
  async subirImagen(file: Express.Multer.File, key: string): Promise<string> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('El archivo está vacío');
    }
    if (this.usaS3) {
      return this.subirAS3(file, key);
    }
    return this.guardarLocal(file, key);
  }

  async eliminarImagen(url: string): Promise<void> {
    if (!url) return;
    // Sólo borramos de S3 las URLs que apuntan a nuestro bucket.
    if (this.usaS3 && url.includes(this.bucket)) {
      try {
        const key = this.urlAKey(url);
        await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } catch (err) {
        // No fallar el borrado de BD si S3 ya no tiene el objeto.
        this.logger.warn(`No se pudo borrar de S3: ${(err as Error).message}`);
      }
      return;
    }
    // Fallback local: borrar bajo uploads/.
    const filename = url.split('/files/').pop();
    if (filename) {
      try {
        await unlink(join(process.cwd(), 'uploads', filename));
      } catch {
        // Archivo local ya inexistente: ignorar.
      }
    }
  }

  private async subirAS3(file: Express.Multer.File, key: string): Promise<string> {
    await this.s3!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        // El bucket se sirve en público; permitimos cachear agresivamente.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return this.urlPublica(key);
  }

  private urlPublica(key: string): string {
    if (this.publicUrlBase) return `${this.publicUrlBase.replace(/\/$/, '')}/${key}`;
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  private urlAKey(url: string): string {
    // La URL pública termina en /<key>. Extraemos el key desde el segmento
    // del bucket o desde la base pública.
    const base = this.publicUrlBase
      ? this.publicUrlBase.replace(/\/$/, '')
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    return url.startsWith(base) ? url.slice(base.length + 1) : url;
  }

  private async guardarLocal(file: Express.Multer.File, key: string): Promise<string> {
    const uploadsDir = join(process.cwd(), 'uploads');
    await mkdir(uploadsDir, { recursive: true });
    const filename = `${randomUUID()}-${key.split('/').pop()}`;
    await writeFile(join(uploadsDir, filename), file.buffer);
    return `/files/${filename}`;
  }
}
