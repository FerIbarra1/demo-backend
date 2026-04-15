import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FiltroCatalogoDto } from './dto/filtro-catalogo.dto';

@Injectable()
export class CatalogoService {
  constructor(private prisma: PrismaService) {}

  async obtenerProductos(filtros: FiltroCatalogoDto) {
    const { tiendaId, categoria, corridaId, colorId, busqueda, soloDisponibles, pagina = 1, limite = 20 } = filtros;

    if (!tiendaId) {
      throw new NotFoundException('Debe especificar una tienda');
    }

    const skip = (pagina - 1) * limite;

    // Construir where dinámico
    const where: any = {
      tiendaId,
      visible: true,
      producto: {
        activo: true,
      },
    };

    if (categoria) {
      where.producto.categoria = { equals: categoria, mode: 'insensitive' };
    }

    if (busqueda) {
      where.producto.OR = [
        { nombre: { contains: busqueda, mode: 'insensitive' } },
        { codigo: { contains: busqueda, mode: 'insensitive' } },
      ];
    }

    const [productosTienda, total] = await Promise.all([
      this.prisma.productoTienda.findMany({
        where,
        include: {
          producto: {
            include: {
              precios: {
                where: { tiendaId },
                select: { precioBase: true, precioOferta: true },
              },
              preciosCO: {
                where: {
                  tiendaId,
                  ...(corridaId && { corridaId }),
                  ...(colorId && { colorId }),
                  ...(soloDisponibles && {
                    stock: {
                      cantidad: { gt: 0 },
                    },
                  }),
                },
                include: {
                  corrida: true,
                  talla: true,
                  color: true,
                  stock: {
                    select: {
                      cantidad: true,
                      cantidadReservada: true,
                    },
                  },
                },
                orderBy: [
                  { talla: { orden: 'asc' } },
                  { color: { nombre: 'asc' } },
                ],
              },
            },
          },
        },
        orderBy: { orden: 'asc' },
        skip,
        take: limite,
      }),
      this.prisma.productoTienda.count({ where }),
    ]);

    // Transformar respuesta
    const productosFormateados = productosTienda.map((pt) => {
      const producto = pt.producto;
      const precio = producto.precios[0];

      // Agrupar variantes
      const variantes = producto.preciosCO.map((pco) => ({
        id: pco.id,
        corrida: pco.corrida.nombre,
        talla: pco.talla.nombre,
        color: pco.color.nombre,
        colorHex: pco.color.hex,
        precio: pco.precio,
        stockDisponible: pco.stock
          ? pco.stock.cantidad - pco.stock.cantidadReservada
          : 0,
      }));

      return {
        id: producto.id,
        codigo: producto.codigo,
        nombre: producto.nombre,
        descripcion: producto.descripcion,
        imagenPrincipal: producto.imagenPrincipal,
        imagenes: producto.imagenes,
        categoria: producto.categoria,
        subcategoria: producto.subcategoria,
        precioBase: precio?.precioBase || 0,
        precioOferta: precio?.precioOferta,
        variantes,
      };
    });

    return {
      data: productosFormateados,
      meta: {
        total,
        pagina,
        limite,
        totalPaginas: Math.ceil(total / limite),
      },
    };
  }

  async obtenerProductoDetalle(productoId: number, tiendaId: number) {
    const producto = await this.prisma.producto.findUnique({
      where: { id: productoId },
      include: {
        precios: {
          where: { tiendaId },
          select: { precioBase: true, precioOferta: true },
        },
        preciosCO: {
          where: { tiendaId },
          include: {
            corrida: true,
            talla: true,
            color: true,
            stock: {
              select: {
                cantidad: true,
                cantidadReservada: true,
              },
            },
          },
          orderBy: [
            { talla: { orden: 'asc' } },
            { color: { nombre: 'asc' } },
          ],
        },
      },
    });

    if (!producto || !producto.activo) {
      throw new NotFoundException('Producto no encontrado');
    }

    const precio = producto.precios[0];

    // Agrupar variantes por corrida y color
    const variantes = producto.preciosCO.map((pco) => ({
      id: pco.id,
      corridaId: pco.corridaId,
      corrida: pco.corrida.nombre,
      tallaId: pco.tallaId,
      talla: pco.talla.nombre,
      colorId: pco.colorId,
      color: pco.color.nombre,
      colorHex: pco.color.hex,
      sku: pco.sku,
      precio: pco.precio,
      stockDisponible: pco.stock
        ? pco.stock.cantidad - pco.stock.cantidadReservada
        : 0,
    }));

    return {
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre,
      descripcion: producto.descripcion,
      imagenPrincipal: producto.imagenPrincipal,
      imagenes: producto.imagenes,
      categoria: producto.categoria,
      subcategoria: producto.subcategoria,
      precioBase: precio?.precioBase || 0,
      precioOferta: precio?.precioOferta,
      variantes,
    };
  }

  async obtenerFiltrosDisponibles(tiendaId: number) {
    const [categorias, corridas, colores] = await Promise.all([
      this.prisma.producto.groupBy({
        by: ['categoria'],
        where: {
          activo: true,
          productosTienda: { some: { tiendaId, visible: true } },
        },
      }),
      this.prisma.corrida.findMany({
        where: { activa: true },
        include: {
          tallas: {
            orderBy: { orden: 'asc' },
          },
        },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.color.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
      }),
    ]);

    return {
      categorias: categorias.map((c) => c.categoria).filter(Boolean),
      corridas,
      colores,
    };
  }

  async verificarDisponibilidad(items: { precioCOId: number; cantidad: number }[]) {
    const preciosCO = await this.prisma.precioCO.findMany({
      where: {
        id: { in: items.map((i) => i.precioCOId) },
      },
      include: {
        producto: true,
        talla: true,
        color: true,
        stock: true,
      },
    });

    const resultado = items.map((item) => {
      const pco = preciosCO.find((p) => p.id === item.precioCOId);

      if (!pco) {
        return {
          precioCOId: item.precioCOId,
          disponible: false,
          stockActual: 0,
          mensaje: 'Producto no encontrado',
        };
      }

      const stockDisponible = pco.stock
        ? pco.stock.cantidad - pco.stock.cantidadReservada
        : 0;

      return {
        precioCOId: item.precioCOId,
        disponible: stockDisponible >= item.cantidad,
        stockActual: stockDisponible,
        cantidadSolicitada: item.cantidad,
        producto: {
          nombre: pco.producto.nombre,
          talla: pco.talla.nombre,
          color: pco.color.nombre,
        },
        mensaje:
          stockDisponible >= item.cantidad
            ? 'Disponible'
            : `Stock insuficiente. Disponible: ${stockDisponible}`,
      };
    });

    const todosDisponibles = resultado.every((r) => r.disponible);

    return {
      disponible: todosDisponibles,
      items: resultado,
    };
  }
}
