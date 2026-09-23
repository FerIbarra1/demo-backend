import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Estas pruebas cubren la resolución key↔URL, que es el punto donde un error
 * rompe el catálogo completo: una key con leading slash genera `//` en la URL
 * (404 en todas las imágenes) y una ruta legacy mal clasificada apunta a un
 * objeto que no existe.
 */
describe('StorageService — resolución de keys y URLs', () => {
  const crear = (s3: Record<string, unknown> = {}) => {
    const config = {
      get: () => ({
        bucket: 'mi-bucket',
        region: 'us-east-1',
        publicUrlBase: '',
        endpoint: '',
        forcePathStyle: false,
        accessKeyId: '',
        secretAccessKey: '',
        ...s3,
      }),
    } as unknown as ConfigService;
    return new StorageService(config);
  };

  const CON_S3 = { accessKeyId: 'AKIA', secretAccessKey: 'secreto' };

  describe('urlPublica', () => {
    it('construye la URL del bucket cuando no hay base pública', () => {
      expect(crear(CON_S3).urlPublica('productos/1/a.webp')).toBe(
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
      );
    });

    it('normaliza el leading slash para no generar doble slash', () => {
      expect(crear(CON_S3).urlPublica('/productos/1/a.webp')).toBe(
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
      );
    });

    it('usa la base pública cuando está configurada (CDN)', () => {
      const svc = crear({ ...CON_S3, publicUrlBase: 'https://img.ejemplo.com/' });
      expect(svc.urlPublica('productos/1/a.webp')).toBe(
        'https://img.ejemplo.com/productos/1/a.webp',
      );
    });
  });

  describe('keyDeUrl', () => {
    it('extrae la key de una URL del bucket', () => {
      expect(
        crear(CON_S3).keyDeUrl(
          'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
        ),
      ).toBe('productos/1/a.webp');
    });

    it('extrae la key de una URL de CDN', () => {
      const svc = crear({ ...CON_S3, publicUrlBase: 'https://img.ejemplo.com' });
      expect(svc.keyDeUrl('https://img.ejemplo.com/productos/1/a.webp')).toBe(
        'productos/1/a.webp',
      );
    });

    it('devuelve la key tal cual si ya es una key', () => {
      expect(crear(CON_S3).keyDeUrl('productos/1/a.webp')).toBe(
        'productos/1/a.webp',
      );
    });

    it('extrae la key de una ruta local /files/', () => {
      expect(crear().keyDeUrl('/files/productos/1/a.webp')).toBe(
        'productos/1/a.webp',
      );
    });

    it('devuelve vacío para una URL de un dominio ajeno', () => {
      expect(crear(CON_S3).keyDeUrl('https://otro-dominio.com/a.webp')).toBe('');
    });
  });

  describe('resolverImagen', () => {
    it('resuelve una key a URL de S3 cuando hay credenciales', () => {
      expect(crear(CON_S3).resolverImagen('productos/1/a.webp')).toBe(
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
      );
    });

    it('resuelve una key a /files/ cuando no hay S3 (dev)', () => {
      expect(crear().resolverImagen('productos/1/a.webp')).toBe(
        '/files/productos/1/a.webp',
      );
    });

    it('deja intacta una ruta legacy del frontend', () => {
      expect(crear(CON_S3).resolverImagen('/products/C0200-caribe-1.webp')).toBe(
        '/products/C0200-caribe-1.webp',
      );
    });

    it('es idempotente con una URL absoluta', () => {
      const url = 'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp';
      expect(crear(CON_S3).resolverImagen(url)).toBe(url);
    });

    it('deja intacta una ruta /files/ ya resuelta', () => {
      expect(crear().resolverImagen('/files/productos/1/a.webp')).toBe(
        '/files/productos/1/a.webp',
      );
    });

    it('devuelve null para null, undefined y cadena vacía', () => {
      const svc = crear(CON_S3);
      expect(svc.resolverImagen(null)).toBeNull();
      expect(svc.resolverImagen(undefined)).toBeNull();
      expect(svc.resolverImagen('')).toBeNull();
      expect(svc.resolverImagen('   ')).toBeNull();
    });

    it('NO genera doble slash con una key que empieza con /', () => {
      const url = crear(CON_S3).resolverImagen('/productos/1/a.webp');
      expect(url).not.toContain('//productos');
      expect(url).toBe(
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
      );
    });
  });

  describe('resolverImagenes', () => {
    it('resuelve una lista y descarta los vacíos', () => {
      const svc = crear(CON_S3);
      expect(
        svc.resolverImagenes(['productos/1/a.webp', '', null as unknown as string]),
      ).toEqual([
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/a.webp',
      ]);
    });

    it('devuelve [] para null/undefined', () => {
      expect(crear().resolverImagenes(null)).toEqual([]);
      expect(crear().resolverImagenes(undefined)).toEqual([]);
    });
  });

  describe('resolverImagenesPorColor', () => {
    it('resuelve cada entrada del mapa conservando las claves', () => {
      const svc = crear(CON_S3);
      const salida = svc.resolverImagenesPorColor({
        general: ['productos/1/g.webp'],
        3: ['productos/1/c3.webp'],
      });
      expect(salida.general).toEqual([
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/g.webp',
      ]);
      expect(salida[3]).toEqual([
        'https://mi-bucket.s3.us-east-1.amazonaws.com/productos/1/c3.webp',
      ]);
    });
  });

  describe('eliminarImagen', () => {
    it('no borra rutas legacy del frontend (/products/)', async () => {
      await expect(
        crear().eliminarImagen('/products/C0200-caribe-1.webp'),
      ).resolves.toBeUndefined();
    });

    it('ignora una cadena vacía', async () => {
      await expect(crear().eliminarImagen('')).resolves.toBeUndefined();
    });

    it('ignora una URL de un dominio ajeno (key vacía)', async () => {
      await expect(
        crear(CON_S3).eliminarImagen('https://otro-dominio.com/a.webp'),
      ).resolves.toBeUndefined();
    });
  });

  describe('guardia de configuración', () => {
    it('lanza si hay credenciales pero el bucket está vacío', () => {
      expect(() => crear({ ...CON_S3, bucket: '' })).toThrow(/AWS_S3_BUCKET/);
    });

    it('no lanza sin credenciales aunque falte el bucket (modo local)', () => {
      expect(() => crear({ bucket: '' })).not.toThrow();
    });
  });

  describe('usaS3', () => {
    it('es false sin credenciales (fallback a disco local)', () => {
      expect(crear().usaS3).toBe(false);
    });

    it('es true con credenciales', () => {
      expect(crear(CON_S3).usaS3).toBe(true);
    });
  });
});
