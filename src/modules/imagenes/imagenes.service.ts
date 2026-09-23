import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { ListarProductosQueryDto } from './dto/listar-productos-query.dto';
import { detectarMimeImagen } from './validar-imagen.util';
import {
  LIMITE_IMAGEN_BYTES,
  MAX_IMAGENES_POR_COLOR,
} from './imagenes.constants';

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
        imagenes: p.imagenesProducto.map((img) => this.formatearImagen(img)),
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

    const ext = this.extensionDe(file.originalname);
    const key = `productos/${productoId}/${colorId ? `color-${colorId}` : 'general'}/${randomUUID()}${ext}`;
    const url = await this.storage.subirImagen(file, key);

    let imagen;
    try {
      // El tope se valida DENTRO de la transacción: contarlo antes y crear
      // después permite que dos subidas concurrentes lo rebasen.
      imagen = await this.prisma.$transaction(async (tx) => {
        const existentes = await tx.productoImagen.count({
          where: { productoId, colorId: colorId ?? null },
        });
        if (existentes >= MAX_IMAGENES_POR_COLOR) {
          const etiqueta = colorId ? `para este color` : 'generales';
          throw new BadRequestException(
            `Máximo ${MAX_IMAGENES_POR_COLOR} imágenes ${etiqueta} por producto`,
          );
        }

        // `orden` se calcula sobre el máximo existente, no sobre el conteo:
        // borrar una imagen intermedia deja un hueco y el conteo lo reutiliza.
        const ultima = await tx.productoImagen.findFirst({
          where: { productoId, colorId: colorId ?? null },
          orderBy: { orden: 'desc' },
          select: { orden: true },
        });

        return tx.productoImagen.create({
          data: {
            productoId,
            colorId: colorId ?? null,
            url,
            orden: (ultima?.orden ?? -1) + 1,
            // La primera imagen del producto se marca como principal.
            esPrincipal:
              (await tx.productoImagen.count({ where: { productoId } })) === 0,
          },
        });
      });
    } catch (err) {
      // El objeto ya está en S3: sin esta compensación quedaría huérfano
      // (ocupando espacio y contando en la factura) para siempre.
      await this.storage.eliminarImagen(url);
      throw err;
    }

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

    // El objeto se borra PRIMERO: si falla el borrado en BD, el peor caso es un
    // objeto huérfano (recuperable con el job de reconciliación). Al revés, un
    // fallo de S3 dejaría una fila apuntando a un objeto inexistente.
    await this.storage.eliminarImagen(imagen.url);

    await this.prisma.$transaction(async (tx) => {
      await tx.productoImagen.delete({ where: { id: imagenId } });

      // Renumerar el resto: sin esto queda un hueco en `orden` y el siguiente
      // upload puede reutilizar un valor ya tomado.
      const restantes = await tx.productoImagen.findMany({
        where: { productoId, colorId: imagen.colorId },
        orderBy: { orden: 'asc' },
        select: { id: true, orden: true },
      });
      for (const [i, r] of restantes.entries()) {
        if (r.orden === i) continue;
        await tx.productoImagen.update({
          where: { id: r.id },
          data: { orden: i },
        });
      }

      // Si se borró la principal, promover otra.
      if (eraPrincipal) {
        const siguiente = await tx.productoImagen.findFirst({
          where: { productoId },
          orderBy: { orden: 'asc' },
        });
        if (siguiente) {
          await tx.productoImagen.update({
            where: { id: siguiente.id },
            data: { esPrincipal: true },
          });
        }
      }
    });

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
    if (file.size > LIMITE_IMAGEN_BYTES) {
      throw new BadRequestException('La imagen supera el tamaño máximo de 5 MB');
    }
    // El `mimetype` lo declara el cliente y es falsificable: un .svg o .html
    // renombrado llega como image/jpeg. Se valida el contenido real por firma
    // binaria, porque ese valor se usa como ContentType en un bucket público.
    const mimeReal = detectarMimeImagen(file.buffer);
    if (!mimeReal) {
      throw new BadRequestException(
        'El archivo no es una imagen válida. Usa JPG, PNG o WEBP.',
      );
    }
    // Se normaliza para que el ContentType que se envía a S3 sea el detectado,
    // no el declarado por el cliente.
    file.mimetype = mimeReal;
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
      // La BD guarda la key; el panel admin necesita una URL para el <img>.
      url: this.storage.resolverImagen(imagen.url),
      colorId: imagen.colorId,
      orden: imagen.orden,
      esPrincipal: imagen.esPrincipal,
    };
  }
}
