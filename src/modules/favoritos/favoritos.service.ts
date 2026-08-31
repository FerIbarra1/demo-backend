import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Servicio de favoritos.
 *
 * Reglas:
 *   - Sólo CLIENTE puede tener favoritos.
 *   - El producto debe estar activo.
 *   - Las operaciones son idempotentes: añadir 2 veces el mismo producto no
 *     duplica; quitar un producto que no está como favorito no falla.
 */
@Injectable()
export class FavoritosService {
  private readonly logger = new Logger(FavoritosService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Devuelve los productos favoritos del usuario con el detalle necesario
   * para renderizarlos en la UI (mismo shape que /catalogo):
   *   - precioBase y precioOferta filtrados por la tienda del cliente.
   *   - variantes (talla+color+precio) filtradas por la tienda del cliente.
   *
   * Si el usuario no tiene tienda asignada, precioBase/variantes quedan
   * como null/[] (la UI los trata como opcionales y muestra $0.00/—).
   */
  async listar(usuarioId: number, tiendaId?: number) {
    const favoritos = await this.prisma.favorito.findMany({
      where: { usuarioId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        productoId: true,
        createdAt: true,
        producto: {
          select: {
            id: true,
            codigo: true,
            nombre: true,
            descripcion: true,
            imagenPrincipal: true,
            imagenes: true,
            categoria: true,
            subcategoria: true,
            activo: true,
          },
        },
      },
    });

    if (favoritos.length === 0) {
      return [];
    }

    // Si hay tienda, cargamos precios y variantes en bloque (2 queries)
    // para no hacer N+1. Si no hay tienda, los productos van sin detalle
    // de precio/variantes.
    const productoIds = favoritos.map((f) => f.productoId);

    const [precios, variantes] = tiendaId
      ? await Promise.all([
          this.prisma.precio.findMany({
            where: { productoId: { in: productoIds }, tiendaId },
            select: { productoId: true, precioBase: true, precioOferta: true },
          }),
          this.prisma.precioCO.findMany({
            where: { productoId: { in: productoIds }, tiendaId },
            include: {
              corrida: { select: { nombre: true } },
              talla: { select: { nombre: true } },
              color: { select: { nombre: true, hex: true } },
            },
            orderBy: [
              { talla: { orden: 'asc' } },
              { color: { nombre: 'asc' } },
            ],
          }),
        ])
      : [[], []];

    const precioPorProducto = new Map<number, { precioBase: any; precioOferta: any }>();
    for (const p of precios as any[]) {
      precioPorProducto.set(p.productoId, {
        precioBase: p.precioBase,
        precioOferta: p.precioOferta,
      });
    }

    const variantesPorProducto = new Map<number, any[]>();
    for (const pco of variantes as any[]) {
      const list = variantesPorProducto.get(pco.productoId) ?? [];
      list.push({
        id: pco.id,
        corrida: pco.corrida.nombre,
        talla: pco.talla.nombre,
        color: pco.color.nombre,
        colorHex: pco.color.hex,
        precio: pco.precio,
        // B2B: sin manejo de stock. Ver nota en catalogo.service.ts.
        stockDisponible: null,
      });
      variantesPorProducto.set(pco.productoId, list);
    }

    return favoritos.map((f) => {
      const p = f.producto;
      const precio = precioPorProducto.get(f.productoId);
      return {
        id: f.id,
        productoId: f.productoId,
        createdAt: f.createdAt.toISOString(),
        producto: {
          id: p.id,
          codigo: p.codigo,
          nombre: p.nombre,
          descripcion: p.descripcion,
          imagenPrincipal: p.imagenPrincipal,
          imagenes: p.imagenes,
          categoria: p.categoria,
          subcategoria: p.subcategoria,
          activo: p.activo,
          precioBase: precio ? Number(precio.precioBase) : 0,
          precioOferta: precio?.precioOferta ? Number(precio.precioOferta) : null,
          variantes: variantesPorProducto.get(f.productoId) ?? [],
        },
      };
    });
  }

  /** Marca un producto como favorito (idempotente). */
  async agregar(usuarioId: number, productoId: number) {
    const producto = await this.prisma.producto.findUnique({
      where: { id: productoId },
      select: { id: true, activo: true },
    });
    if (!producto || !producto.activo) {
      throw new NotFoundException(`Producto ${productoId} no existe o no está activo`);
    }

    // upsert: si ya existe, no duplica.
    await this.prisma.favorito.upsert({
      where: { usuarioId_productoId: { usuarioId, productoId } },
      create: { usuarioId, productoId },
      update: {},
    });

    this.logger.log(`Usuario ${usuarioId} marcó producto ${productoId} como favorito`);
    return { mensaje: 'Producto añadido a favoritos', productoId };
  }

  /** Quita un producto de favoritos (idempotente: no falla si no existe). */
  async quitar(usuarioId: number, productoId: number) {
    await this.prisma.favorito
      .delete({
        where: { usuarioId_productoId: { usuarioId, productoId } },
      })
      .catch(() => {
        // Si no existe, no es error. Idempotente.
      });

    this.logger.log(`Usuario ${usuarioId} quitó producto ${productoId} de favoritos`);
    return { mensaje: 'Producto quitado de favoritos', productoId };
  }
}