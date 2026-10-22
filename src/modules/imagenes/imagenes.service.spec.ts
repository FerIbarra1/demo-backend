import { BadRequestException } from '@nestjs/common';
import { ImagenesService } from './imagenes.service';

/**
 * Cubre el cambio de modelo: el bucket "general" (colorId null) ya no existe.
 * Cada imagen subida debe pertenecer a un color del producto.
 */

function crearPrismaFako(opts: {
  producto?: { id: number; activo: boolean } | null;
  pertenece?: boolean;
  existentes?: number;
}) {
  return {
    producto: {
      findUnique: () => Promise.resolve(opts.producto ?? null),
      update: () => Promise.resolve({ id: opts.producto?.id ?? 1 }),
    },
    precioCO: {
      findFirst: () => Promise.resolve(opts.pertenece ? { id: 1 } : null),
    },
    productoImagen: {
      count: () => Promise.resolve(opts.existentes ?? 0),
      findFirst: () => Promise.resolve(null),
      create: (args: any) =>
        Promise.resolve({
          id: 1,
          productoId: args.data.productoId,
          colorId: args.data.colorId,
          url: args.data.url,
          orden: args.data.orden,
          esPrincipal: args.data.esPrincipal,
        }),
      delete: () => Promise.resolve(),
      findMany: () => Promise.resolve([]),
      update: () => Promise.resolve(),
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    $transaction: async (cb: any) =>
      cb({
        productoImagen: {
          count: () => Promise.resolve(opts.existentes ?? 0),
          findFirst: () => Promise.resolve(null),
          create: (args: any) =>
            Promise.resolve({
              id: 1,
              productoId: args.data.productoId,
              colorId: args.data.colorId,
              url: args.data.url,
              orden: args.data.orden,
              esPrincipal: args.data.esPrincipal,
            }),
          delete: () => Promise.resolve(),
          findMany: () => Promise.resolve([]),
          update: () => Promise.resolve(),
        },
      }),
  } as any;
}

function crearStorageFako() {
  return {
    subirImagen: (_file: any, key: string) => Promise.resolve(`key://${key}`),
    eliminarImagen: () => Promise.resolve(),
    resolverImagen: (url: string) => url,
  } as any;
}

function crearFile(): Express.Multer.File {
  // Buffer con magic-byte JPEG. `detectarMimeImagen` exige >=12 bytes;
  // JPEG se identifica por los primeros 3 (FF D8 FF) y no requiere más.
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  return {
    fieldname: 'file',
    originalname: 'x.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    buffer: buf,
    size: buf.length,
  } as unknown as Express.Multer.File;
}

describe('ImagenesService.subirImagen — exige color', () => {
  it('lanza BadRequest si el color no pertenece al producto', async () => {
    const prisma = crearPrismaFako({
      producto: { id: 1, activo: true },
      pertenece: false,
    });
    const svc = new ImagenesService(prisma, crearStorageFako());

    await expect(svc.subirImagen(1, 99, crearFile())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lanza NotFound si el producto no existe o está inactivo', async () => {
    const prisma = crearPrismaFako({ producto: null, pertenece: true });
    const svc = new ImagenesService(prisma, crearStorageFako());

    await expect(svc.subirImagen(1, 2, crearFile())).rejects.toThrow(/Producto no encontrado/i);
  });

  it('lanza BadRequest si ya hay 4 imágenes para el color', async () => {
    const prisma = crearPrismaFako({
      producto: { id: 1, activo: true },
      pertenece: true,
      existentes: 4,
    });
    const svc = new ImagenesService(prisma, crearStorageFako());

    await expect(svc.subirImagen(1, 2, crearFile())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sube la imagen cuando el color pertenece y hay tope', async () => {
    const prisma = crearPrismaFako({
      producto: { id: 1, activo: true },
      pertenece: true,
      existentes: 1,
    });
    const svc = new ImagenesService(prisma, crearStorageFako());

    const out = await svc.subirImagen(1, 2, crearFile());
    expect(out.colorId).toBe(2);
    // La key ya no lleva 'general' — siempre va en 'color-N'.
    expect(out.url).toContain('color-2');
    expect(out.url).not.toContain('general');
  });
});
