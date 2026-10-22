import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, stat, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { dirname, normalize, resolve, sep } from 'path';
import type { Readable } from 'stream';

/**
 * Almacenamiento PRIVADO de los archivos de DTF (los diseños son propiedad intelectual del cliente).
 * Mismo criterio que `ComprobanteStorageService`: la BD guarda la KEY (nunca una URL), el archivo solo
 * sale por un endpoint autorizado y nada es legible por URL pública.
 *
 *   · Con credenciales de S3: bucket `AWS_S3_DTF_BUCKET` (privado) o el prefijo `dtf/` del bucket de
 *     imágenes. Al subir se COMPRUEBA que el prefijo no sea legible sin credenciales (falla cerrado).
 *   · Sin credenciales (dev): disco `storage-privado/dtf/`, fuera de `uploads/` (lo único que se sirve).
 *
 * A diferencia de los comprobantes (8 MB, en memoria), aquí se mueve por STREAM: un PDF de DTF pesa
 * decenas o cientos de MB y no debe pasar entero por la RAM del API.
 */
@Injectable()
export class DtfStorageService {
  private readonly logger = new Logger(DtfStorageService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly region: string;
  private readonly directorio = resolve(process.cwd(), 'storage-privado');
  private privacidad: { ok: boolean; hasta: number } | null = null;
  /** Disco local privado: sin credenciales, `DTF_STORAGE=local`, o (solo fuera de producción) si el bucket no pasa la prueba de privacidad. */
  private local = false;

  constructor(config: ConfigService) {
    const s3 = config.get('app.s3') || {};
    this.bucket = config.get<string>('app.dtf.bucket') || s3.bucket || '';
    this.region = s3.region || 'us-east-1';
    this.s3 =
      s3.accessKeyId && s3.secretAccessKey
        ? new S3Client({
            region: this.region,
            credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
            ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
            ...(s3.forcePathStyle ? { forcePathStyle: true } : {}),
            maxAttempts: 3,
            requestHandler: new NodeHttpHandler({
              connectionTimeout: 5_000,
              requestTimeout: 120_000,
              throwOnRequestTimeout: true,
            }),
          })
        : null;
    this.local = !this.s3 || process.env.DTF_STORAGE === 'local';
  }

  private rutaLocal(key: string): string {
    const ruta = resolve(this.directorio, normalize(key));
    if (!ruta.startsWith(this.directorio + sep))
      throw new NotFoundException('Archivo no encontrado');
    return ruta;
  }

  /** Falla CERRADO si el prefijo `dtf/` es legible sin credenciales. */
  private async asegurarPrivacidad(): Promise<void> {
    if (!this.s3 || this.local) return;
    if (this.privacidad && Date.now() < this.privacidad.hasta) {
      if (this.privacidad.ok) return;
      throw new ServiceUnavailableException(
        'No podemos recibir archivos en este momento. Inténtalo más tarde.',
      );
    }
    const key = `dtf/_prueba-privacidad/${randomUUID()}.txt`;
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: Buffer.from('prueba'),
          ContentType: 'text/plain',
        }),
      );
      const url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
      const status = await fetch(url, { signal: AbortSignal.timeout(6_000) })
        .then((r) => r.status)
        .catch(() => null);
      const ok = status !== null && status !== 200;
      this.privacidad = { ok, hasta: Date.now() + (ok ? 6 * 3_600_000 : 120_000) };
      if (!ok)
        this.logger.error(
          `El prefijo dtf/ de ${this.bucket} es público o no se pudo comprobar: no se guarda nada.`,
        );
    } catch (e) {
      this.privacidad = { ok: false, hasta: Date.now() + 120_000 };
      this.logger.error(
        `DTF: no se pudo escribir en s3://${this.bucket}/dtf/ (${(e as Error).message})`,
      );
    } finally {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
        .catch(() => undefined);
    }
    if (!this.privacidad?.ok) {
      // En desarrollo no se bloquea la función por un bucket sin configurar: se usa el disco privado
      // (storage-privado/, 0600, fuera de lo que se sirve por HTTP). En producción SÍ falla cerrado.
      if (process.env.NODE_ENV !== 'production') {
        this.local = true;
        this.logger.warn(
          'DTF: el bucket no pasó la prueba de privacidad; en desarrollo se guarda en storage-privado/.',
        );
        return;
      }
      throw new ServiceUnavailableException(
        'No podemos recibir archivos en este momento. Inténtalo más tarde.',
      );
    }
  }

  /** Mueve un archivo temporal a su lugar definitivo y devuelve la KEY. */
  async guardarDesdeRuta(
    rutaTmp: string,
    dtfId: number,
    version: number,
    ext: string,
  ): Promise<string> {
    await this.asegurarPrivacidad();
    const key = `dtf/${dtfId}/v${version}-${randomUUID()}.${ext}`;
    await this.escribir(key, rutaTmp, ext === 'pdf' ? 'application/pdf' : 'image/png');
    return key;
  }

  /** La vista previa (PNG con transparencia) generada por el motor. */
  async guardarPreview(rutaTmp: string, dtfId: number, version: number): Promise<string> {
    const key = `dtf/${dtfId}/v${version}-preview-${randomUUID()}.png`;
    await this.escribir(key, rutaTmp, 'image/png');
    return key;
  }

  private async escribir(key: string, rutaTmp: string, contentType: string): Promise<void> {
    if (this.s3 && !this.local) {
      const { size } = await stat(rutaTmp);
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(rutaTmp),
          ContentLength: size,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
      return;
    }
    const destino = this.rutaLocal(key);
    await mkdir(dirname(destino), { recursive: true });
    await pipeline(createReadStream(rutaTmp), createWriteStream(destino, { mode: 0o600 }));
  }

  async leer(key: string): Promise<{ stream: Readable; bytes?: number }> {
    // La decisión "disco local o S3" se toma en `asegurarPrivacidad`, que antes SOLO corría al escribir.
    // Tras reiniciar el API (en desarrollo, cada cambio de código), una lectura anterior a la primera
    // subida iba a S3, fallaba y respondía 500 aunque los archivos estaban en `storage-privado/`.
    await this.asegurarPrivacidad();
    if (this.s3 && !this.local) {
      try {
        const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return { stream: r.Body as Readable, bytes: r.ContentLength };
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey')
          throw new NotFoundException('El archivo ya no está disponible');
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

  async eliminar(key: string): Promise<void> {
    try {
      await this.asegurarPrivacidad();
      if (this.s3 && !this.local)
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      else await unlink(this.rutaLocal(key));
    } catch (e) {
      this.logger.warn(`No se pudo borrar ${key}: ${(e as Error).message}`);
    }
  }
}
