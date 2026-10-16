import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ComprobanteStorageService } from './comprobante-storage.service';

/**
 * El almacenamiento de comprobantes FALLA CERRADO: solo guarda si comprobó, de verdad, que el
 * prefijo no es legible sin credenciales. Estos tests fijan esa promesa con un S3 y un "internet"
 * falsos.
 */
type Cfg = { s3?: Record<string, unknown>; bucket?: string };

function crear({ s3, bucket }: Cfg = {}) {
  const config = {
    get: (k: string) => ({ 'app.s3': s3 ?? {}, 'app.pagos.comprobantes.bucket': bucket ?? '' })[k],
  };
  const svc = new ComprobanteStorageService(config as never);
  const enviados: Array<{ tipo: string; key: string; bucket: string }> = [];
  const falsoS3 = {
    send: jest.fn(
      async (cmd: { constructor: { name: string }; input: { Key: string; Bucket: string } }) => {
        enviados.push({ tipo: cmd.constructor.name, key: cmd.input.Key, bucket: cmd.input.Bucket });
        return {};
      },
    ),
  };
  (svc as unknown as { s3: unknown }).s3 = s3 ? falsoS3 : null;
  const http = jest.fn<Promise<number | null>, [string]>().mockResolvedValue(403);
  (svc as unknown as { peticionAnonima: unknown }).peticionAnonima = http;
  return { svc, falsoS3, enviados, http };
}

const S3 = {
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  bucket: 'imagenes-bucket',
  region: 'us-west-2',
  publicUrlBase: 'https://img.tienda.test/',
};
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(30),
]);

describe('ComprobanteStorageService — con S3 (bucket compartido)', () => {
  it('prefijo privado (403 anónimo): guarda bajo comprobantes/ y borra el archivo de prueba', async () => {
    const { svc, enviados, http } = crear({ s3: S3 });
    const key = await svc.guardar(PNG, 'image/png', 7);
    expect(key).toMatch(/^comprobantes\/7\/[0-9a-f-]+\.png$/);
    const puts = enviados.filter((e) => e.tipo === 'PutObjectCommand');
    expect(puts).toHaveLength(2); // la prueba + el comprobante
    expect(puts.every((p) => p.bucket === 'imagenes-bucket')).toBe(true);
    expect(enviados.filter((e) => e.tipo === 'DeleteObjectCommand')).toHaveLength(1);
    // Probó la URL directa de S3 Y la del CDN de las imágenes.
    const urls = http.mock.calls.map((c) => c[0]);
    expect(
      urls.some((u) =>
        u.startsWith('https://imagenes-bucket.s3.us-west-2.amazonaws.com/comprobantes/'),
      ),
    ).toBe(true);
    expect(urls.some((u) => u.startsWith('https://img.tienda.test/comprobantes/'))).toBe(true);
  });

  it('prefijo de LECTURA PÚBLICA (200 anónimo): se niega a guardar y no sube el comprobante', async () => {
    const { svc, enviados, http } = crear({ s3: S3 });
    http.mockResolvedValue(200);
    await expect(svc.guardar(PNG, 'image/png', 7)).rejects.toThrow(ServiceUnavailableException);
    // Solo se subió el archivo de prueba (y se borró): el comprobante real NUNCA salió.
    expect(enviados.filter((e) => e.tipo === 'PutObjectCommand')).toHaveLength(1);
    expect(enviados.filter((e) => e.tipo === 'DeleteObjectCommand')).toHaveLength(1);
  });

  it('el CDN de las imágenes expone el prefijo aunque la URL directa de S3 no: también se niega', async () => {
    const { svc, http } = crear({ s3: S3 });
    http.mockImplementation(async (url: string) =>
      url.startsWith('https://img.tienda.test') ? 200 : 403,
    );
    await expect(svc.guardar(PNG, 'image/png', 7)).rejects.toThrow(ServiceUnavailableException);
  });

  it('sin respuesta del anónimo no se puede afirmar que sea privado: falla cerrado', async () => {
    const { svc, http } = crear({ s3: S3 });
    http.mockResolvedValue(null);
    await expect(svc.guardar(PNG, 'image/png', 7)).rejects.toThrow(ServiceUnavailableException);
  });

  it('sin permiso de escritura en comprobantes/ lo dice (503) y no intenta nada más', async () => {
    const { svc, falsoS3, http } = crear({ s3: S3 });
    falsoS3.send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(svc.guardar(PNG, 'image/png', 7)).rejects.toThrow(ServiceUnavailableException);
    expect(http).not.toHaveBeenCalled();
  });

  it('la prueba se hace UNA vez: los siguientes comprobantes no la repiten', async () => {
    const { svc, http } = crear({ s3: S3 });
    await svc.guardar(PNG, 'image/png', 1);
    const llamadas = http.mock.calls.length;
    await svc.guardar(PNG, 'image/png', 2);
    expect(http.mock.calls.length).toBe(llamadas);
  });

  it('dos subidas simultáneas comparten la misma prueba', async () => {
    const { svc, http } = crear({ s3: S3 });
    await Promise.all([svc.guardar(PNG, 'image/png', 1), svc.guardar(PNG, 'image/png', 2)]);
    expect(http.mock.calls.length).toBe(2); // 2 URLs, una sola ronda de prueba
  });

  it('con bucket dedicado usa ESE bucket y no mira el CDN de las imágenes', async () => {
    const { svc, enviados, http } = crear({ s3: S3, bucket: 'solo-comprobantes' });
    await svc.guardar(PNG, 'image/png', 3);
    expect(enviados.every((e) => e.bucket === 'solo-comprobantes')).toBe(true);
    expect(http.mock.calls.every((c) => !c[0].includes('img.tienda.test'))).toBe(true);
  });
});

describe('ComprobanteStorageService — disco local (dev, sin credenciales)', () => {
  let dir: string;
  let spy: jest.SpyInstance;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'comprobantes-'));
    spy = jest.spyOn(process, 'cwd').mockReturnValue(dir);
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('guarda fuera de uploads/ y se puede leer de vuelta', async () => {
    const { svc } = crear();
    const key = await svc.guardar(PNG, 'image/png', 9);
    const { stream, bytes } = await svc.leer(key);
    expect(bytes).toBe(PNG.length);
    const partes: Buffer[] = [];
    for await (const c of stream) partes.push(c as Buffer);
    expect(Buffer.concat(partes).equals(PNG)).toBe(true);
    // Fuera de `uploads/` (que se sirve en /files/).
    const dirLocal = (svc as unknown as { directorioLocal: string }).directorioLocal;
    expect(dirLocal).toContain('storage-privado');
    expect(dirLocal).not.toContain('uploads');
  });

  it('una key con ../ no puede salirse del directorio', async () => {
    const { svc } = crear();
    await expect(svc.leer('../../etc/passwd')).rejects.toThrow(NotFoundException);
    await expect(svc.leer('comprobantes/../../../secreto.txt')).rejects.toThrow(NotFoundException);
  });

  it('leer algo que no existe es 404', async () => {
    const { svc } = crear();
    await expect(svc.leer('comprobantes/1/no-existe.png')).rejects.toThrow(NotFoundException);
  });

  it('eliminar quita el archivo', async () => {
    const { svc } = crear();
    const key = await svc.guardar(PNG, 'image/png', 9);
    await svc.eliminar(key);
    await expect(svc.leer(key)).rejects.toThrow(NotFoundException);
  });
});
