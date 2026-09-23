import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { mkdir, writeFile, unlink } from 'fs/promises';

/**
 * StorageService: sube, elimina y **resuelve** las imágenes.
 *
 * Contrato: la BD guarda una **key** de storage (`productos/1/color-3/uuid.webp`),
 * nunca una URL. `urlPublica()` la resuelve a URL en el borde de la API, así que
 * cambiar de bucket, de región o a un CDN es cambiar una env — no reescribir la
 * base de datos.
 *
 * Excepción histórica: las filas del seed guardan rutas del frontend
 * (`/products/x.webp`). `resolverImagen()` las detecta y las deja intactas
 * (el navegador las resuelve contra el origen del frontend), de modo que el
 * catálogo sigue vivo entre el despliegue de esta fase y la migración de datos.
 *
 * Si hay credenciales AWS configuradas sube a S3; si no (dev sin AWS), cae a disco
 * local bajo `uploads/`, servido por main.ts en `/files/`.
 */

/** Timeouts del cliente S3. Sin ellos un S3 colgado cuelga el request indefinidamente. */
const S3_CONNECTION_TIMEOUT_MS = 5_000;
const S3_REQUEST_TIMEOUT_MS = 15_000;
const S3_MAX_ATTEMPTS = 3;

/** Prefijo de las rutas heredadas que apuntan a `public/` del frontend. */
const PREFIJO_LEGACY_FRONTEND = '/products/';

/**
 * Prefijo para objetos temporales (healthcheck). Debe estar en la política IAM
 * además de `productos/*`, o el healthcheck del arranque reportará un falso
 * "S3 NO responde" aunque las subidas funcionen.
 */
const PREFIJO_TMP = 'tmp/';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly publicUrlBase: string;
  private readonly endpoint: string;
  private readonly forcePathStyle: boolean;

  constructor(private readonly config: ConfigService) {
    const s3Config = this.config.get('app.s3') || {};
    this.bucket = s3Config.bucket || '';
    this.region = s3Config.region || 'us-east-1';
    this.publicUrlBase = s3Config.publicUrlBase || '';
    this.endpoint = s3Config.endpoint || '';
    this.forcePathStyle = s3Config.forcePathStyle === true;
    const accessKeyId = s3Config.accessKeyId || '';
    const secretAccessKey = s3Config.secretAccessKey || '';

    // Guardia: credenciales presentes pero bucket vacío construiría URLs como
    // `https://.s3.us-east-1.amazonaws.com/...` y subiría a un bucket ''. Fallar
    // al arrancar es preferible a un fallback silencioso que rompa en producción.
    if (accessKeyId && secretAccessKey && !this.bucket) {
      throw new Error(
        'AWS_S3_BUCKET es obligatorio cuando hay credenciales AWS configuradas.',
      );
    }

    // Sólo instanciar S3 si hay credenciales. Sin ellas → disco local.
    this.s3 =
      accessKeyId && secretAccessKey
        ? new S3Client({
            region: this.region,
            credentials: { accessKeyId, secretAccessKey },
            // Endpoint custom para proveedores S3-compatibles (R2, MinIO, Spaces).
            ...(this.endpoint ? { endpoint: this.endpoint } : {}),
            ...(this.forcePathStyle ? { forcePathStyle: true } : {}),
            maxAttempts: S3_MAX_ATTEMPTS,
            requestHandler: new NodeHttpHandler({
              connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
              requestTimeout: S3_REQUEST_TIMEOUT_MS,
              // Sin esto, exceder requestTimeout s��lo emite un warning y el
              // request sigue vivo: el timeout no serviría de nada.
              throwOnRequestTimeout: true,
            }),
          })
        : null;
  }

  get usaS3(): boolean {
    return this.s3 !== null;
  }

  /** Comprueba que el bucket sea alcanzable. Se llama al arrancar. */
  async verificarConexion(): Promise<void> {
    if (!this.usaS3) {
      this.logger.log('Storage: disco local (sin credenciales AWS).');
      return;
    }
    try {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: PREFIJO_TMP + 'healthcheck',
          Body: Buffer.from('ok'),
        }),
      );
      await this.s3!.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: PREFIJO_TMP + 'healthcheck',
        }),
      );
      this.logger.log(`Storage: S3 OK (bucket ${this.bucket}, ${this.region}).`);
    } catch (err) {
      // No abortar el arranque: el catálogo sigue sirviendo imágenes ya
      // existentes aunque la subida esté caída. Pero debe quedar muy visible.
      const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
      const codigo = e.name ?? '';
      const status = e.$metadata?.httpStatusCode;

      // Distinguir el diagnóstico importa: "sin permisos" y "no responde" se
      // arreglan de forma distinta, y un mensaje genérico manda a buscar el
      // problema en el lugar equivocado.
      if (codigo === 'AccessDenied' || status === 403) {
        this.logger.error(
          `Storage: S3 responde pero RECHAZA la escritura en ${PREFIJO_TMP}*. ` +
            `Revisa que la política IAM incluya s3:PutObject y s3:DeleteObject ` +
            `sobre arn:aws:s3:::${this.bucket}/${PREFIJO_TMP}* (el healthcheck ` +
            `escribe ahí al arrancar).`,
        );
      } else if (codigo === 'PermanentRedirect' || status === 301) {
        this.logger.error(
          `Storage: el bucket ${this.bucket} NO está en ${this.region}. ` +
            `AWS_REGION debe coincidir exactamente con la región del bucket, ` +
            `o las subidas fallarán y las URLs públicas quedarán rotas.`,
        );
      } else if (codigo === 'NoSuchBucket' || status === 404) {
        this.logger.error(
          `Storage: el bucket ${this.bucket} no existe. Revisa AWS_S3_BUCKET.`,
        );
      } else {
        this.logger.error(
          `Storage: S3 no responde (bucket ${this.bucket}, ${this.region}). ` +
            `Las subidas fallarán: ${e.message}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // Resolución (el borde de la API)
  // ---------------------------------------------------------------

  /**
   * Resuelve a URL cualquier valor de imagen que venga de la BD.
   *
   * - Key de storage (`productos/1/...`) → URL del bucket/CDN.
   * - Ruta legacy del frontend (`/products/x.webp`) → se devuelve igual: el
   *   navegador la resuelve contra el origen del frontend.
   * - URL absoluta → se devuelve igual (idempotente).
   * - `null`/`''` → `null`.
   */
  resolverImagen(valor?: string | null): string | null {
    if (!valor || valor.trim().length === 0) return null;
    const v = valor.trim();
    if (this.esRutaLegacyFrontend(v)) return v;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('/files/')) return v;
    // Sin S3 (dev) la key se sirve desde el propio backend.
    return this.usaS3 ? this.urlPublica(v) : this.urlLocalDeKey(v);
  }

  /** Igual que `resolverImagen` pero para listas. */
  resolverImagenes(valores?: string[] | null): string[] {
    if (!valores?.length) return [];
    return valores.map((v) => this.resolverImagen(v)).filter((v): v is string => !!v);
  }

  /** Resuelve un mapa `{ colorId | 'general': string[] }`. */
  resolverImagenesPorColor(
    mapa: Record<number | 'general', string[]>,
  ): Record<number | 'general', string[]> {
    const salida: Record<number | 'general', string[]> = { general: [] };
    for (const [k, urls] of Object.entries(mapa)) {
      salida[k as unknown as number | 'general'] = this.resolverImagenes(urls);
    }
    return salida;
  }

  // ---------------------------------------------------------------
  // Subida y borrado
  // ---------------------------------------------------------------

  /**
   * Sube un archivo y devuelve la **key** con la que se persistirá en BD.
   * `key` debe ser única por imagen (p.ej. productos/1/color-3/uuid.jpg).
   */
  async subirImagen(file: Express.Multer.File, key: string): Promise<string> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('El archivo está vacío');
    }
    const keyLimpia = this.normalizarKey(key);
    if (this.usaS3) {
      await this.subirAS3(file, keyLimpia);
    } else {
      await this.guardarLocal(file, keyLimpia);
    }
    return keyLimpia;
  }

  /**
   * Elimina el objeto apuntado por `url` o `key`. Acepta ambas formas porque la
   * BD puede tener keys nuevas y rutas legacy a la vez.
   */
  async eliminarImagen(urlOKey: string): Promise<void> {
    if (!urlOKey) return;

    // Ruta legacy del frontend (`/products/...`): no es nuestra, no se borra.
    if (this.esRutaLegacyFrontend(urlOKey)) return;

    const key = this.keyDeUrl(urlOKey);
    if (!key) return;

    if (this.usaS3) {
      try {
        await this.s3!.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
      } catch (err) {
        // No fallar el borrado de BD si S3 ya no tiene el objeto.
        this.logger.warn(`No se pudo borrar de S3: ${(err as Error).message}`);
      }
      return;
    }

    // Fallback local: borrar bajo uploads/.
    try {
      await unlink(this.rutaLocalSegura(key));
    } catch {
      // Archivo local ya inexistente: ignorar.
    }
  }

  /** Resuelve una key a su URL pública. */
  urlPublica(key: string): string {
    const limpia = this.normalizarKey(key);
    if (this.publicUrlBase) {
      return `${this.publicUrlBase.replace(/\/$/, '')}/${limpia}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${limpia}`;
  }

  /** Extrae la key de una URL absoluta. Si ya es una key, la devuelve igual. */
  keyDeUrl(urlOKey: string): string {
    const base = this.publicUrlBase
      ? this.publicUrlBase.replace(/\/$/, '')
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com`;

    // URL absoluta de nuestro bucket/CDN: quitar la base.
    if (urlOKey.startsWith(base)) {
      return this.normalizarKey(urlOKey.slice(base.length));
    }
    // Cualquier otra URL absoluta no es nuestra.
    if (/^https?:\/\//i.test(urlOKey)) return '';
    // Prefijo de disco local: /files/<nombre>.
    if (urlOKey.startsWith('/files/')) {
      return this.normalizarKey(urlOKey.slice('/files/'.length));
    }
    return this.normalizarKey(urlOKey);
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  /** Quita slashes iniciales para que la key nunca genere `//` en la URL. */
  private normalizarKey(key: string): string {
    return key.replace(/^\/+/, '');
  }

  /**
   * Las rutas `/products/*.webp` son assets estáticos del frontend, no objetos
   * de nuestro storage. Distinguirlas evita que un `keyDeUrl` mal formado
   * apunte a una key arbitraria, y permite dejar el catálogo intacto antes de
   * migrar los datos.
   */
  private esRutaLegacyFrontend(valor: string): boolean {
    return valor.startsWith(PREFIJO_LEGACY_FRONTEND);
  }

  /**
   * Resuelve la ruta en disco de una key, garantizando que quede dentro de
   * `uploads/`. Sin esto, una key con `../` escribiría o borraría fuera del
   * directorio (path traversal).
   *
   * La estructura de directorios replica la de S3 (`uploads/productos/1/...`)
   * para que la key haga round-trip: `/files/<key>` ↔ `<key>`.
   */
  private rutaLocalSegura(key: string): string {
    const uploadsDir = resolve(process.cwd(), 'uploads');
    const destino = resolve(uploadsDir, key);
    if (destino !== uploadsDir && !destino.startsWith(uploadsDir + '/')) {
      throw new BadRequestException('Ruta de archivo inválida');
    }
    return destino;
  }

  private async subirAS3(file: Express.Multer.File, key: string): Promise<void> {
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
  }

  private async guardarLocal(
    file: Express.Multer.File,
    key: string,
  ): Promise<void> {
    const destino = this.rutaLocalSegura(key);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, file.buffer);
  }

  /**
   * URL con la que el backend sirve una key cuando no hay S3 (dev).
   *
   * LIMITACIÓN CONOCIDA (solo dev): es una ruta relativa, así que el navegador
   * la resuelve contra el origen del FRONTEND (3001), no del backend (3000).
   * Sirve para `<img>` del catálogo y del panel admin porque el fallback local
   * es una comodidad de desarrollo; NO sirve para `og:image` ni para correos,
   * que exigen URL absoluta — ahí la solución es configurar S3 (o
   * `AWS_S3_PUBLIC_URL` apuntando al backend).
   */
  private urlLocalDeKey(key: string): string {
    return `/files/${key}`;
  }
}
