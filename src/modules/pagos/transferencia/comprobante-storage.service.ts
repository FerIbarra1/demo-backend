import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, stat, unlink, writeFile } from 'fs/promises';
import { dirname, normalize, resolve, sep } from 'path';
import type { Readable } from 'stream';
import { MimeComprobante, extensionDeMime } from './validar-comprobante.util';

const MENSAJE_NO_DISPONIBLE =
  'No podemos recibir comprobantes en este momento. Inténtalo más tarde o paga en tienda.';

/**
 * Almacenamiento PRIVADO de comprobantes de transferencia.
 *
 * NO es `StorageService`: ese es de bucket PÚBLICO (las imágenes de producto se sirven por URL).
 * Un comprobante trae la cuenta, el nombre y los montos del cliente; si quedara al alcance de
 * cualquiera que adivine una URL, serían datos bancarios publicados.
 *
 * Dónde se guarda:
 *   1. `AWS_S3_COMPROBANTES_BUCKET` si está definido (lo ideal: un bucket sin lectura pública), o
 *   2. el MISMO bucket y credenciales de las imágenes de producto, bajo el prefijo `comprobantes/`
 *      (no hace falta crear nada para empezar), o
 *   3. sin credenciales de S3 (dev): disco local en `storage-privado/`, FUERA de `uploads/` (lo
 *      único que se sirve por HTTP en `/files/`).
 *
 * Falla CERRADO: antes de guardar el primer comprobante (y al arrancar) se PRUEBA, de verdad, que
 * el prefijo no sea legible sin credenciales: se sube un archivo de prueba, se intenta leer por su
 * URL pública y se borra. Si responde 200, la política del bucket lo expone (p. ej. lectura pública
 * para todo `/*`) y NO se guarda nada: subir un comprobante da 503 con el motivo en el log. Es la
 * diferencia entre "creo que está privado" y "comprobé que lo está".
 *
 * El archivo solo sale por un endpoint con autorización (no hay URL pública ni prefirmada) y la BD
 * guarda la KEY, nunca una URL.
 */
@Injectable()
export class ComprobanteStorageService implements OnModuleInit {
  private readonly logger = new Logger(ComprobanteStorageService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly publicUrlBase: string;
  private readonly bucketEsCompartido: boolean;
  private readonly directorioLocal: string;
  /** Resultado de la prueba de privacidad. Un éxito dura; un fallo se reintenta pronto. */
  private privacidad: { ok: boolean; motivo?: string; hasta: number } | null = null;
  private pruebaEnCurso: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {
    const s3 = this.config.get('app.s3') || {};
    const propio = this.config.get<string>('app.pagos.comprobantes.bucket') || '';
    this.bucket = propio || s3.bucket || '';
    this.bucketEsCompartido = !propio;
    this.region = s3.region || 'us-east-1';
    this.endpoint = s3.endpoint || '';
    this.publicUrlBase = (s3.publicUrlBase || '').replace(/\/+$/, '');
    this.directorioLocal = resolve(process.cwd(), 'storage-privado');
    const hayCredenciales = !!(s3.accessKeyId && s3.secretAccessKey);
    this.s3 = hayCredenciales
      ? new S3Client({
          region: this.region,
          credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
          ...(this.endpoint ? { endpoint: this.endpoint } : {}),
          ...(s3.forcePathStyle ? { forcePathStyle: true } : {}),
          maxAttempts: 3,
          requestHandler: new NodeHttpHandler({
            connectionTimeout: 5_000,
            requestTimeout: 20_000,
            throwOnRequestTimeout: true,
          }),
        })
      : null;
  }

  /** Avisa al arrancar si los comprobantes no se podrán guardar, en vez de enterarse con el primer cliente. */
  onModuleInit() {
    if (!this.s3) {
      this.logger.log(
        'Comprobantes: disco local privado (storage-privado/), sin credenciales de S3.',
      );
      return;
    }
    void this.asegurarPrivacidad()
      .then(() =>
        this.logger.log(
          `Comprobantes: S3 OK y PRIVADO (${this.bucket}, prefijo comprobantes/` +
            `${this.bucketEsCompartido ? ', bucket compartido con las imágenes' : ''}).`,
        ),
      )
      .catch(() => undefined); // el motivo ya quedó en el log
  }

  /** Hace una petición SIN credenciales. Devuelve el status HTTP, o null si no hubo respuesta. */
  protected async peticionAnonima(url: string): Promise<number | null> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      return r.status;
    } catch {
      return null;
    }
  }

  /** URLs por las que un objeto del prefijo sería legible por cualquiera, si estuviera expuesto. */
  private urlsPublicasDe(key: string): string[] {
    const directa = this.endpoint
      ? `${this.endpoint.replace(/\/+$/, '')}/${this.bucket}/${key}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
    const urls = [directa];
    // El CDN / dominio propio de las imágenes también puede estar sirviendo todo el bucket.
    if (this.bucketEsCompartido && this.publicUrlBase) urls.push(`${this.publicUrlBase}/${key}`);
    return urls;
  }

  /**
   * Comprueba que el prefijo de comprobantes sea escribible por nosotros y NO legible por nadie
   * más. Lanza 503 (con el motivo en el log) si no. Se comparte entre llamadas simultáneas.
   */
  private async asegurarPrivacidad(): Promise<void> {
    if (!this.s3) return;
    const ahora = Date.now();
    if (this.privacidad && ahora < this.privacidad.hasta) {
      if (this.privacidad.ok) return;
      throw new ServiceUnavailableException(MENSAJE_NO_DISPONIBLE);
    }
    this.pruebaEnCurso ??= this.probarPrivacidad().finally(() => {
      this.pruebaEnCurso = null;
    });
    await this.pruebaEnCurso;
    if (!this.privacidad?.ok) throw new ServiceUnavailableException(MENSAJE_NO_DISPONIBLE);
  }

  private async probarPrivacidad(): Promise<void> {
    const s3 = this.s3!;
    const key = `comprobantes/_prueba-privacidad/${randomUUID()}.txt`;
    const fallar = (motivo: string, minutos: number) => {
      this.privacidad = { ok: false, motivo, hasta: Date.now() + minutos * 60_000 };
      this.logger.error(`Comprobantes NO disponibles: ${motivo}`);
    };

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: Buffer.from('prueba de privacidad'),
          ContentType: 'text/plain',
        }),
      );
    } catch (err) {
      fallar(
        `no se pudo escribir en s3://${this.bucket}/comprobantes/ (${(err as Error).message}). ` +
          'La política IAM debe permitir s3:PutObject, s3:GetObject y s3:DeleteObject sobre ' +
          `arn:aws:s3:::${this.bucket}/comprobantes/*.`,
        2,
      );
      return;
    }

    try {
      for (const url of this.urlsPublicasDe(key)) {
        const status = await this.peticionAnonima(url);
        if (status === 200) {
          fallar(
            `el prefijo comprobantes/ es de LECTURA PÚBLICA (${url} respondió 200 sin credenciales). ` +
              'Guardar ahí publicaría los datos bancarios de los clientes. Quita la lectura pública ' +
              'de comprobantes/* en la política del bucket (o usa AWS_S3_COMPROBANTES_BUCKET con un ' +
              'bucket privado).',
            2,
          );
          return;
        }
        if (status === null) {
          // Sin respuesta no se puede afirmar que sea privado: se falla cerrado y se reintenta pronto.
          fallar(`no se pudo comprobar la privacidad (sin respuesta de ${url}); se reintenta.`, 1);
          return;
        }
      }
      this.privacidad = { ok: true, hasta: Date.now() + 6 * 3_600_000 };
    } finally {
      // Best-effort: un archivo de prueba suelto no contiene nada sensible.
      await s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
        .catch((e) => this.logger.warn(`No se pudo borrar el archivo de prueba: ${e.message}`));
    }
  }

  /** Sube el archivo y devuelve la KEY con la que se persiste. */
  async guardar(buffer: Buffer, mime: MimeComprobante, pagoId: number): Promise<string> {
    await this.asegurarPrivacidad();
    const key = `comprobantes/${pagoId}/${randomUUID()}.${extensionDeMime(mime)}`;
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mime,
          // Defensa extra: aunque alguien cambiara la política del bucket, el objeto se cifra.
          ServerSideEncryption: 'AES256',
        }),
      );
    } else {
      const ruta = this.rutaLocal(key);
      await mkdir(dirname(ruta), { recursive: true });
      await writeFile(ruta, buffer, { mode: 0o600 });
    }
    return key;
  }

  /** Abre el archivo para servirlo. Lanza 404 si no existe. */
  async leer(key: string): Promise<{ stream: Readable; bytes?: number }> {
    if (this.s3) {
      try {
        const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return { stream: r.Body as Readable, bytes: r.ContentLength };
      } catch (err) {
        const nombre = (err as { name?: string }).name;
        if (nombre === 'NoSuchKey') throw new NotFoundException('El archivo ya no está disponible');
        if (nombre === 'AccessDenied') {
          this.logger.error(
            `Sin permiso s3:GetObject sobre ${this.bucket}/comprobantes/*: Tesorería no puede ver los comprobantes.`,
          );
          throw new ServiceUnavailableException(MENSAJE_NO_DISPONIBLE);
        }
        throw err;
      }
    }
    const ruta = this.rutaLocal(key);
    try {
      const info = await stat(ruta);
      return { stream: createReadStream(ruta), bytes: info.size };
    } catch {
      throw new NotFoundException('El archivo ya no está disponible');
    }
  }

  /** Borra un archivo huérfano (la subida terminó pero la transacción falló). Best-effort. */
  async eliminar(key: string): Promise<void> {
    try {
      if (this.s3) {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      } else {
        await unlink(this.rutaLocal(key));
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo borrar el comprobante huérfano ${key}: ${(err as Error).message}`,
      );
    }
  }

  /** Ruta en disco de una key, sin permitir salirse de `storage-privado/`. */
  private rutaLocal(key: string): string {
    const ruta = resolve(this.directorioLocal, normalize(key));
    if (!ruta.startsWith(this.directorioLocal + sep)) {
      throw new NotFoundException('Archivo no encontrado');
    }
    return ruta;
  }
}
