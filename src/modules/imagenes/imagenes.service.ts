import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { ListarProductosQueryDto } from './dto/listar-productos-query.dto';

const MAX_IMAGENES_POR_COLOR = 4;

@Injectable()
export class ImagenesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Lista productos con sus colores y las imágenes agrupadas por color.
   * Usado por el panel ADMIN para gestionar imágenes.
   */
  async listarProductos(query: ListarProductosQueryDto) {
    const { busqueda, pagina = 1, limite = 20 } = query;
    const where: any = { activo: true };
    if (busqueda) {
      where.OR = [
        { nombre: { contains: busqueda, mode: 'insensitive' } },
        { codigo: { contains: busqueda, mode: 'insensitive' } },
      ];
    }

    const [productos, total] = await Promise.all([
      this.prisma.producto.findMany({
        where,
        include: {
          imagenesProducto: { orderBy: { orden: 'asc' } },
          preciosCO: {
            select: { color: { select: { id: true, nombre: true, hex: true } } },
            distinct: ['colorId'],
          },
        },
        orderBy: { codigo: 'asc' },
        skip: (pagina - 1) * limite,
        take: limite,
      }),
      this.prisma.producto.count({ where }),
    ]);

    return {
      data: productos.map((p) => ({
        id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        categoria: p.categoria,
        subcategoria: p.subcategoria,
        // Colores del producto (de sus variantes PrecioCO).
        colores: p.preciosCO
          .map((pc) => pc.color)
          .filter((c) => !!c)
          .map((c) => ({ id: c!.id, nombre: c!.nombre, hex: c!.hex })),
        // Imágenes agrupadas: general (colorId null) + por color.
        imagenes: p.imagenesProducto.map((img) => ({
          id: img.id,
          url: img.url,
          colorId: img.colorId,
          orden: img.orden,
          esPrincipal: img.esPrincipal,
        })),
        totalImagenes: p.imagenesProducto.length,
      })),
      meta: { total, pagina, limite, totalPaginas: Math.ceil(total / limite) },
    };
  }

  /** Detalle de un producto para el panel de imágenes. */
  async obtenerProducto(productoId: number) {
    const producto = await this.prisma.producto.findUnique({
      where: { id: productoId },
      include: {
        imagenesProducto: { orderBy: { orden: 'asc' } },
        preciosCO: {
          select: { color: { select: { id: true, nombre: true, hex: true } } },
          distinct: ['colorId'],
        },
      },
    });
    if (!producto || !producto.activo) {
      throw new NotFoundException('Producto no encontrado');
    }
    return this.formatearProducto(producto);
  }

  /**
   * Sube una imagen (multipart) para un producto. `colorId` opcional.
   * Valida el tipo/mime y el tope de 4 imágenes por (producto, color).
   */
  async subirImagen(
    productoId: number,
    colorId: number | undefined,
    file: Express.Multer.File,
  ) {
    const producto = await this.prisma.producto.findUnique({
      where: { id: productoId },
      select: { id: true, activo: true },
    });
    if (!producto || !producto.activo) {
      throw new NotFoundException('Producto no encontrado');
    }

    if (!file) {
      throw new BadRequestException('No se recibió ningún archivo');
    }
    this.validarArchivo(file);

    if (colorId) {
      // El color debe existir y pertenecer al producto (vía PrecioCO).
      const pertenece = await this.prisma.precioCO.findFirst({
        where: { productoId, colorId },
        select: { id: true },
      });
      if (!pertenece) {
        throw new BadRequestException('El color no pertenece a este producto');
      }
    }

    // Tope de 4 imágenes por (producto, color).
    const existentes = await this.prisma.productoImagen.count({
      where: { productoId, colorId: colorId ?? null },
    });
    if (existentes >= MAX_IMAGENES_POR_COLOR) {
      const etiqueta = colorId ? `para este color` : 'generales';
      throw new BadRequestException(
        `Máximo ${MAX_IMAGENES_POR_COLOR} imágenes ${etiqueta} por producto`,
      );
    }

    const ext = this.extensionDe(file.originalname);
    const key = `productos/${productoId}/${colorId ? `color-${colorId}` : 'general'}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const url = await this.storage.subirImagen(file, key);

    const imagen = await this.prisma.productoImagen.create({
      data: {
        productoId,
        colorId: colorId ?? null,
        url,
        orden: existentes,
        // La primera imagen (general) se marca como principal si no hay ninguna.
        esPrincipal:
          (await this.prisma.productoImagen.count({ where: { productoId } })) === 0,
      },
    });

    await this.actualizarCamposLegacy(productoId);

    return this.formatearImagen(imagen);
  }

  async eliminarImagen(productoId: number, imagenId: number) {
    const imagen = await this.prisma.productoImagen.findFirst({
      where: { id: imagenId, productoId },
    });
    if (!imagen) {
      throw new NotFoundException('Imagen no encontrada');
    }
    const eraPrincipal = imagen.esPrincipal;

    await this.prisma.productoImagen.delete({ where: { id: imagenId } });
    await this.storage.eliminarImagen(imagen.url);

    // Si se borró la principal, promover otra.
    if (eraPrincipal) {
      const siguiente = await this.prisma.productoImagen.findFirst({
        where: { productoId },
        orderBy: { orden: 'asc' },
      });
      if (siguiente) {
        await this.prisma.productoImagen.update({
          where: { id: siguiente.id },
          data: { esPrincipal: true },
        });
      }
    }

    await this.actualizarCamposLegacy(productoId);
    return { mensaje: 'Imagen eliminada' };
  }

  async marcarPrincipal(productoId: number, imagenId: number) {
    const imagen = await this.prisma.productoImagen.findFirst({
      where: { id: imagenId, productoId },
    });
    if (!imagen) {
      throw new NotFoundException('Imagen no encontrada');
    }
    await this.prisma.$transaction([
      this.prisma.productoImagen.updateMany({
        where: { productoId },
        data: { esPrincipal: false },
      }),
      this.prisma.productoImagen.update({
        where: { id: imagenId },
        data: { esPrincipal: true },
      }),
    ]);
    await this.actualizarCamposLegacy(productoId);
    return { mensaje: 'Imagen marcada como principal' };
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  private validarArchivo(file: Express.Multer.File) {
    const permitidos = ['image/jpeg', 'image/png', 'image/webp'];
    if (!permitidos.includes(file.mimetype)) {
      throw new BadRequestException(
        'Formato no permitido. Usa JPG, PNG o WEBP.',
      );
    }
    const maxBytes = 5 * 1024 * 1024; // 5 MB
    if (file.size > maxBytes) {
      throw new BadRequestException('La imagen supera el tamaño máximo de 5 MB');
    }
  }

  private extensionDe(originalname: string): string {
    const ext = originalname.split('.').pop()?.toLowerCase() || '';
    return ext && ['.jpg', '.jpeg', '.png', '.webp'].includes(`.${ext}`)
      ? `.${ext}`
      : '.jpg';
  }

  /**
   * Mantiene imagenPrincipal/imagenes (campos legacy que consumen las vistas
   * existentes de catálogo/carrito/favoritos) en sync con ProductoImagen.
   */
  private async actualizarCamposLegacy(productoId: number) {
    const imagenes = await this.prisma.productoImagen.findMany({
      where: { productoId },
      orderBy: [{ esPrincipal: 'desc' }, { orden: 'asc' }],
      select: { url: true, esPrincipal: true },
    });
    const principal = imagenes.find((i) => i.esPrincipal) || imagenes[0];
    await this.prisma.producto.update({
      where: { id: productoId },
      data: {
        imagenPrincipal: principal?.url || null,
        imagenes: imagenes.map((i) => i.url),
      },
    });
  }

  private formatearProducto(producto: any) {
    return {
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre,
      categoria: producto.categoria,
      subcategoria: producto.subcategoria,
      colores: producto.preciosCO
        .map((pc: any) => pc.color)
        .filter((c: any) => !!c)
        .map((c: any) => ({ id: c.id, nombre: c.nombre, hex: c.hex })),
      imagenes: producto.imagenesProducto.map((img: any) =>
        this.formatearImagen(img),
      ),
    };
  }

  private formatearImagen(imagen: any) {
    return {
      id: imagen.id,
      url: imagen.url,
      colorId: imagen.colorId,
      orden: imagen.orden,
      esPrincipal: imagen.esPrincipal,
    };
  }
}
