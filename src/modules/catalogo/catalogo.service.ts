import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../imagenes/storage.service';
import { PreciosService } from '../precios/precios.service';
import { ColumnaLista } from '../precios/precio-lista.util';
import { FiltroCatalogoDto } from './dto/filtro-catalogo.dto';

/**
 * Fase 0 (sep 2026): la resolución de la lista de precios del cliente se movió
 * a `PreciosService` + `precio-lista.util.ts`.
 *
 * Antes vivía privada aquí (`resolverColumnaLista` + `obtenerColumnaLista`), y
 * eso permitió que el catálogo respetara la lista del cliente mientras el
 * PEDIDO se creaba con `PrecioCO.precio` (siempre `lista1`). Ahora los dos
 * caminos comparten la misma regla y no pueden divergir.
 */
@Injectable()
export class CatalogoService {
  constructor(
    private prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly precios: PreciosService,
  ) {}

  async obtenerProductos(filtros: FiltroCatalogoDto, usuarioId?: number) {
    const { tiendaId, categoria, corridaId, colorId, busqueda, pagina = 1, limite = 20 } = filtros;

    if (!tiendaId) {
      throw new NotFoundException('Debe especificar una tienda');
    }

    // F9: detectar la lista de precios del cliente logueado.
    const columnaLista = await this.precios.columnaParaUsuario(usuarioId, tiendaId);

    const skip = (pagina - 1) * limite;

    // B2B: no hay stock en tiempo real. El "soloDisponibles" sólo filtra
    // productos visibles y activos.
    const where: any = {
      tiendaId,
      visible: true,
      producto: { activo: true },
    };

    if (categoria) {
      where.producto.categoria = { equals: categoria, mode: 'insensitive' };
    }

    // Filtrar por color a nivel de PRODUCTO (no solo de variante): solo
    // traer productos que tengan al menos una variante (PrecioCO) de ese
    // color en la tienda. Sin esto, el colorId solo recortaba las variantes
    // del include y el catálogo devolvía todos los productos.
    if (colorId) {
      where.producto.preciosCO = { some: { tiendaId, colorId } };
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
              imagenesProducto: {
                select: { id: true, url: true, colorId: true, esPrincipal: true },
                orderBy: { orden: 'asc' },
              },
              precios: {
                where: { tiendaId },
                select: {
                  precioBase: true,
                  precioOferta: true,
                  // F9: incluir la lista del cliente para evitar un round-trip.
                  lista1: true,
                  lista2: true,
                  lista3: true,
                  lista4: true,
                  lista5: true,
                  lista6: true,
                },
              },
              preciosCO: {
                where: {
                  tiendaId,
                  ...(corridaId && { corridaId }),
                  ...(colorId && { colorId }),
                },
                select: {
                  id: true,
                  colorId: true,
                  precio: true,
                  lista1: true,
                  lista2: true,
                  lista3: true,
                  lista4: true,
                  lista5: true,
                  lista6: true,
                  corrida: true,
                  talla: true,
                  color: true,
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

    // Si hay usuario autenticado, cargamos sus favoritos para marcarlos.
    const favoritosSet = usuarioId
      ? await this.cargarFavoritosDelUsuario(usuarioId)
      : new Set<number>();

    const productosFormateados = productosTienda.map((pt) => {
      const producto = pt.producto;
      const precio = producto.precios[0];
      // F9: precioBase según la lista del cliente. Si no hay precio para
      // la lista del cliente, fallback a precioBase.
      const precioBaseLista = precio ? Number(precio[columnaLista] ?? 0) : 0;
      const precioBase = precioBaseLista > 0 ? precioBaseLista : Number(precio?.precioBase ?? 0);
      const variantes = producto.preciosCO.map((pco) => {
        const pcoPrecioLista = Number(pco[columnaLista] ?? 0);
        return {
          id: pco.id,
          // precioCOId es el id de PrecioCO (la variante viva). Necesario
          // para que la pantalla de surtir pueda proponer sustituciones
          // (quick option "Otra variante" / "Otro producto").
          precioCOId: pco.id,
          corrida: pco.corrida.nombre,
          talla: pco.talla.nombre,
          colorId: pco.colorId,
          color: pco.color.nombre,
          colorHex: pco.color.hex,
          // F9: mismo criterio que precioBase — usar la lista del cliente.
          precio: pcoPrecioLista > 0 ? pcoPrecioLista : Number(pco.precio),
          // B2B: sin manejo de stock. La disponibilidad la confirma bodega al
          // revisar el pedido. Este campo existe por compatibilidad con la
          // UI legacy; el frontend debe ignorarlo.
          stockDisponible: null,
        };
      });
      // Imágenes agrupadas por color (colorId null = generales).
      const imagenesPorColor: Record<number | 'general', string[]> = {
        general: [],
      };
      for (const img of producto.imagenesProducto) {
        const k = img.colorId ?? 'general';
        if (!imagenesPorColor[k]) imagenesPorColor[k] = [];
        imagenesPorColor[k].push(img.url);
      }
      return {
        id: producto.id,
        codigo: producto.codigo,
        nombre: producto.nombre,
        descripcion: producto.descripcion,
        // La BD guarda keys; el borde de la API las resuelve a URL.
        imagenPrincipal: this.storage.resolverImagen(producto.imagenPrincipal),
        imagenes: this.storage.resolverImagenes(producto.imagenes),
        imagenesPorColor: this.storage.resolverImagenesPorColor(imagenesPorColor),
        categoria: producto.categoria,
        subcategoria: producto.subcategoria,
        precioBase,
        precioOferta: precio?.precioOferta,
        variantes,
        esFavorito: favoritosSet.has(producto.id),
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

  async obtenerProductoDetalle(productoId: number, tiendaId: number, usuarioId?: number) {
    const columnaLista = await this.precios.columnaParaUsuario(usuarioId, tiendaId);
    const producto = await this.prisma.producto.findUnique({
      where: { id: productoId },
      include: {
        productosTienda: {
          where: { tiendaId, visible: true },
          select: { id: true },
        },
        imagenesProducto: {
          select: { id: true, url: true, colorId: true, esPrincipal: true },
          orderBy: { orden: 'asc' },
        },
        precios: {
          where: { tiendaId },
          select: {
            precioBase: true,
            precioOferta: true,
            lista1: true,
            lista2: true,
            lista3: true,
            lista4: true,
            lista5: true,
            lista6: true,
          },
        },
        preciosCO: {
          where: { tiendaId },
          include: { corrida: true, talla: true, color: true },
          orderBy: [
            { talla: { orden: 'asc' } },
            { color: { nombre: 'asc' } },
          ],
        },
      },
    });

    if (!producto || !producto.activo || producto.productosTienda.length === 0) {
      throw new NotFoundException('Producto no encontrado');
    }

    const precio = producto.precios[0];
    const precioBaseLista = precio ? Number(precio[columnaLista] ?? 0) : 0;
    const precioBase = precioBaseLista > 0 ? precioBaseLista : Number(precio?.precioBase ?? 0);
    const variantes = producto.preciosCO.map((pco) => {
      const precioLista = Number(pco[columnaLista] ?? 0);
      return {
        id: pco.id,
        precioCOId: pco.id,
        corridaId: pco.corridaId,
        corrida: pco.corrida.nombre,
        tallaId: pco.tallaId,
        talla: pco.talla.nombre,
        colorId: pco.colorId,
        color: pco.color.nombre,
        colorHex: pco.color.hex,
        sku: pco.sku,
        precio: precioLista > 0 ? precioLista : Number(pco.precio),
        stockDisponible: null,
      };
    });

    const imagenesPorColor: Record<number | 'general', string[]> = {
      general: [],
    };
    for (const img of producto.imagenesProducto) {
      const k = img.colorId ?? 'general';
      if (!imagenesPorColor[k]) imagenesPorColor[k] = [];
      imagenesPorColor[k].push(img.url);
    }

    return {
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre,
      descripcion: producto.descripcion,
      imagenPrincipal: this.storage.resolverImagen(producto.imagenPrincipal),
      imagenes: this.storage.resolverImagenes(producto.imagenes),
      imagenesPorColor: this.storage.resolverImagenesPorColor(imagenesPorColor),
      categoria: producto.categoria,
      subcategoria: producto.subcategoria,
      precioBase,
      precioOferta: precio?.precioOferta,
      variantes,
    };
  }

  async obtenerFiltrosDisponibles(tiendaId: number, usuarioId?: number) {
    const columnaLista = await this.precios.columnaParaUsuario(
      usuarioId,
      tiendaId,
    );

    const [categorias, corridas, colores, precioMaximo] = await Promise.all([
      this.prisma.producto.groupBy({
        by: ['categoria'],
        where: {
          activo: true,
          productosTienda: { some: { tiendaId, visible: true } },
        },
      }),
      this.prisma.corrida.findMany({
        where: { activa: true },
        include: { tallas: { orderBy: { orden: 'asc' } } },
        orderBy: { nombre: 'asc' },
      }),
      this.prisma.color.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
      }),
      this.precioMaximoDeLista(tiendaId, columnaLista),
    ]);

    return {
      categorias: categorias.map((c) => c.categoria).filter(Boolean),
      corridas,
      colores,
      precioMaximo,
    };
  }

  /**
   * Tope del slider de precios: el mayor precio que verá ESTE cliente.
   *
   * Sale de la lista del cliente (`columnaLista`), no de `precioBase` — que es
   * sinónimo de lista1. Sin esto un cliente de lista 6 (la más barata) recibía
   * un slider calibrado con precios de lista 1 y el rango no correspondía a
   * nada de lo que veía en pantalla. Un visitante anónimo resuelve a `lista1`,
   * que es el comportamiento anterior.
   *
   * Cada fila aporta su valor de lista y, si esa lista no está capturada (0),
   * su precio base — el mismo fallback que aplica `precioDeLista` al mostrar.
   * Por eso cada mitad se agrega con su propio `where`: tomar `MAX(listaN)` y
   * `MAX(precio)` sobre TODAS las filas daría un tope inflado, porque el
   * `precio` de una fila que sí tiene lista capturada no es lo que se muestra.
   *
   * Se consideran variantes (`PrecioCO`) y precios de producto (`Precio`): el
   * frontend filtra por la primera variante y cae a `precioBase` si no hay.
   */
  private async precioMaximoDeLista(
    tiendaId: number,
    columnaLista: ColumnaLista,
  ): Promise<number> {
    // `Precio` tiene `activo`; `PrecioCO` no (la variante viva es la fila).
    const productoVisible = {
      producto: {
        activo: true,
        productosTienda: { some: { tiendaId, visible: true } },
      },
    };
    const whereCO = { tiendaId, ...productoVisible };
    const wherePrecio = { tiendaId, activo: true, ...productoVisible };

    const [coLista, coBase, prodLista, prodBase] = await Promise.all([
      this.prisma.precioCO.aggregate({
        _max: { [columnaLista]: true },
        where: { ...whereCO, [columnaLista]: { gt: 0 } },
      }),
      this.prisma.precioCO.aggregate({
        _max: { precio: true },
        where: { ...whereCO, [columnaLista]: { lte: 0 } },
      }),
      this.prisma.precio.aggregate({
        _max: { [columnaLista]: true },
        where: { ...wherePrecio, [columnaLista]: { gt: 0 } },
      }),
      this.prisma.precio.aggregate({
        _max: { precioBase: true },
        where: { ...wherePrecio, [columnaLista]: { lte: 0 } },
      }),
    ]);

    const candidatos = [
      coLista._max[columnaLista],
      coBase._max.precio,
      prodLista._max[columnaLista],
      prodBase._max.precioBase,
    ];
    return candidatos.reduce<number>(
      (max, valor) => Math.max(max, Number(valor ?? 0)),
      0,
    );
  }

  /**
   * Resuelve un set de precioCOIds a un objeto con datos mínimos para mostrar
   * en el carrito/checkout. Devuelve [] si la lista está vacía.
   */
  async obtenerPreciosPorIds(ids: number[], tiendaId?: number, usuarioId?: number) {
    if (ids.length === 0) return [];
    const columnaLista = await this.precios.columnaParaUsuario(usuarioId, tiendaId);
    const precios = await this.prisma.precioCO.findMany({
      where: {
        id: { in: ids },
        ...(tiendaId ? { tiendaId } : {}),
      },
      include: {
        producto: {
          include: {
            imagenesProducto: { select: { url: true, colorId: true } },
          },
        },
        talla: true,
        color: true,
        corrida: true,
      },
    });
    return precios.map((p) => {
      const precioLista = Number(p[columnaLista] ?? 0);
      // Imagen del color de la variante (si el producto tiene imágenes
      // asociadas a ese color); fallback a la imagen principal del producto.
      const imagenColor = p.producto.imagenesProducto.find(
        (img) => img.colorId === p.colorId,
      )?.url;
      return {
      id: p.id,
      tiendaId: p.tiendaId,
      precio: precioLista > 0 ? precioLista : Number(p.precio),
      producto: {
        id: p.producto.id,
        codigo: p.producto.codigo,
        nombre: p.producto.nombre,
        imagenPrincipal: this.storage.resolverImagen(p.producto.imagenPrincipal),
      },
      variante: {
        corrida: p.corrida.nombre,
        talla: p.talla.nombre,
        colorId: p.colorId,
        color: p.color.nombre,
        colorHex: p.color.hex,
        imagen: this.storage.resolverImagen(
          imagenColor ?? p.producto.imagenPrincipal,
        ),
      },
      };
    });
  }

  /**
   * Devuelve el set de productoIds marcados como favoritos por el usuario.
   * Usado por el endpoint de catálogo para inyectar esFavorito por producto.
   */
  private async cargarFavoritosDelUsuario(usuarioId: number): Promise<Set<number>> {
    const rows = await this.prisma.favorito.findMany({
      where: { usuarioId },
      select: { productoId: true },
    });
    return new Set(rows.map((r) => r.productoId));
  }
}
