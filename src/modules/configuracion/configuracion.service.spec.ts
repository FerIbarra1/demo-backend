import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { ConfiguracionService } from './configuracion.service';
import { CLAVE_LOGO } from './configuracion.constants';

/**
 * Cubre la resolución del logo: BD primero, fallback a la env después.
 * El bug que estas pruebas previenen es que un cambio de logo desde el admin
 * no se refleje en los correos (por cachear el valor en config).
 */
describe('ConfiguracionService — logo', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);

  const crear = (opts: { fila?: unknown; usaS3?: boolean } = {}) => {
    const prisma = {
      configuracionSitio: {
        findUnique: jest.fn().mockResolvedValue(opts.fila ?? null),
        upsert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const storage = {
      usaS3: opts.usaS3 ?? false,
      resolverImagen: (v: string | null) => (v ? `https://cdn.test/${v}` : null),
      subirImagen: jest.fn(async (_f: unknown, key: string) => key),
      eliminarImagen: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: () => 'http://localhost:3001/Logo.png',
    } as unknown as ConfigService;
    return {
      svc: new ConfiguracionService(
        prisma as never,
        storage as never,
        config,
      ),
      prisma,
      storage,
    };
  };

  describe('obtenerLogoUrl', () => {
    it('usa el logo de la BD cuando existe', async () => {
      const { svc } = crear({ fila: { valor: 'branding/logo/x.png' } });
      await expect(svc.obtenerLogoUrl()).resolves.toBe(
        'https://cdn.test/branding/logo/x.png',
      );
    });

    it('cae al fallback de la env cuando no hay logo en BD', async () => {
      const { svc } = crear({ fila: null });
      await expect(svc.obtenerLogoUrl()).resolves.toBe(
        'http://localhost:3001/Logo.png',
      );
    });

    it('cae al fallback si la fila existe pero el valor está vacío', async () => {
      const { svc } = crear({ fila: { valor: '' } });
      await expect(svc.obtenerLogoUrl()).resolves.toBe(
        'http://localhost:3001/Logo.png',
      );
    });
  });

  describe('subirLogo', () => {
    const archivo = (over: Partial<Express.Multer.File> = {}) =>
      ({
        buffer: PNG,
        size: PNG.length,
        mimetype: 'image/png',
        originalname: 'logo.png',
        ...over,
      }) as Express.Multer.File;

    it('sube con prefijo branding/ y persiste la key', async () => {
      const { svc, prisma, storage } = crear();
      await svc.subirLogo(archivo());

      const [file, key] = storage.subirImagen.mock.calls[0] as [
        Express.Multer.File,
        string,
      ];
      expect(key).toMatch(/^branding\/logo\/[0-9a-f-]+\.png$/);
      expect(file.mimetype).toBe('image/png');
      expect(prisma.configuracionSitio.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clave: CLAVE_LOGO },
          create: expect.objectContaining({ clave: CLAVE_LOGO }),
        }),
      );
    });

    it('rechaza un archivo que no es imagen real (magic bytes)', async () => {
      const { svc } = crear();
      const svg = archivo({
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        size: 40,
      });
      await expect(svc.subirLogo(svg)).rejects.toThrow(BadRequestException);
    });

    it('rechaza un archivo vacío', async () => {
      const { svc } = crear();
      await expect(
        svc.subirLogo(archivo({ buffer: Buffer.alloc(0), size: 0 })),
      ).rejects.toThrow(BadRequestException);
    });

    it('borra el logo anterior tras persistir el nuevo', async () => {
      const { svc, storage } = crear({
        fila: { valor: 'branding/logo/viejo.png' },
      });
      await svc.subirLogo(archivo());
      expect(storage.eliminarImagen).toHaveBeenCalledWith(
        'branding/logo/viejo.png',
      );
    });

    it('no intenta borrar si no había logo previo', async () => {
      const { svc, storage } = crear({ fila: null });
      await svc.subirLogo(archivo());
      expect(storage.eliminarImagen).not.toHaveBeenCalled();
    });
  });

  describe('eliminarLogo', () => {
    it('borra la fila y el objeto de S3', async () => {
      const { svc, prisma, storage } = crear({
        fila: { valor: 'branding/logo/x.png' },
      });
      const res = await svc.eliminarLogo();
      expect(prisma.configuracionSitio.delete).toHaveBeenCalledWith({
        where: { clave: CLAVE_LOGO },
      });
      expect(storage.eliminarImagen).toHaveBeenCalledWith('branding/logo/x.png');
      expect(res.mensaje).toBe('Logo eliminado');
    });

    it('es idempotente si no había logo', async () => {
      const { svc, storage } = crear({ fila: null });
      const res = await svc.eliminarLogo();
      expect(storage.eliminarImagen).not.toHaveBeenCalled();
      expect(res.mensaje).toMatch(/No había logo/);
    });
  });
});
