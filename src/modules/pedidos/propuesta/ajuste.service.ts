import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EstadoSurtido, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../imagenes/storage.service';
import { PreciosService } from '../../precios/precios.service';
import { COLUMNA_MAYOREO, precioDeLista } from '../../precios/precio-lista.util';
import { UserContext } from '../../../types/pedido.types';
import { PedidoAccessService } from '../core/pedido-access.service';
import {
  calcularAjuste,
  type AgregadoParaCalculo,
  type IntencionAjuste,
  type ResultadoAjuste,
} from '../core/calculadora-ajuste.util';

/**
 * Oct 2026 (Fase 2): arma el resultado de un ajuste a partir de la INTENCIÓN del
 * asesor o del operador.
 *
 * `calcularAjuste` es dominio puro y no sabe de la BD. Este servicio hace lo que
 * le toca a un servicio: cargar los items activos del pedido (con la imagen
 * resuelta), resolver contra el catálogo las variantes que se agregan —con la
 * lista de precios del CLIENTE que hizo el pedido— y pasárselo todo.
 *
 * Lo usan dos sitios, y por eso viven juntos:
 *   - `vistaPrevia`: el editor muestra filas y total. Lo que se ve sale de la
 *     misma función que arma la propuesta, así que no puede discrepar.
 *   - `calcular`: `MessagesService.crearConAdjunto` lo llama al enviar la
 *     contrapropuesta, dentro de su transacción.
 */
@Injectable()
export class AjusteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PedidoAccessService,
    private readonly precios: PreciosService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Lo que el editor muestra mientras el usuario arma el ajuste. Solo lectura:
   * no exige un estado concreto del pedido (el que envía o aplica es quien valida
   * que el pedido se pueda ajustar), solo que el usuario pueda verlo.
   */
  async vistaPrevia(
    pedidoId: number,
    intenciones: IntencionAjuste[],
    usuario: UserContext,
  ): Promise<ResultadoAjuste> {
    await this.access.cargarYValidar(pedidoId, usuario);
    return this.calcular(pedidoId, intenciones);
  }

  /**
   * Calcula el ajuste sobre el estado ACTUAL del pedido.
   *
   * `cliente` permite hacerlo dentro de la transacción del caller: la propuesta
   * se guarda con el mismo estado de items que se leyó, sin que un cambio
   * intermedio la deje describiendo otro pedido.
   */
  async calcular(
    pedidoId: number,
    intenciones: IntencionAjuste[],
    cliente: Prisma.TransactionClient = this.prisma,
  ): Promise<ResultadoAjuste> {
    const pedido = await cliente.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true, usuarioId: true, tiendaId: true },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');

    // Las vivas y las que bodega no encontró (`sePuedeReponer`): estas últimas solo
    // sirven de destino de un REPONER, no entran al total ni al snapshot si nadie
    // las repone. El filtro grueso es de la BD; el fino lo hace la calculadora.
    const items = await cliente.itemPedido.findMany({
      where: {
        pedidoId,
        OR: [
          { cancelada: false },
          { cancelada: true, estadoSurtido: EstadoSurtido.NO_DISPONIBLE, cantidadSurtida: 0 },
        ],
      },
      orderBy: { id: 'asc' },
      include: {
        producto: {
          select: {
            imagenPrincipal: true,
            imagenesProducto: { select: { url: true, colorId: true } },
          },
        },
        precioCO: { select: { colorId: true } },
      },
    });

    const itemsParaCalculo = items.map((i) => ({
      ...i,
      productoImagen: this.imagenDe(i.producto, i.precioCO?.colorId),
    }));

    const agregados = await this.resolverAgregados(cliente, pedido, intenciones);
    return calcularAjuste(itemsParaCalculo, intenciones, agregados);
  }

  /**
   * Resuelve las variantes de los AGREGAR contra el catálogo.
   *
   * Los dos precios son los que `construirItemPedido` congelará en el item al
   * aprobar: la lista del CLIENTE que hizo el pedido (no `pco.precio`, que es
   * siempre lista 1, ni la del asesor, que no tiene una) y la lista 2. Fallar
   * aquí —variante inexistente o de otra tienda— hace que el asesor se entere al
   * ENVIAR, y no cuando el cliente aprueba y recibe un 400 sin entender por qué.
   */
  private async resolverAgregados(
    cliente: Prisma.TransactionClient,
    pedido: { usuarioId: number; tiendaId: number },
    intenciones: IntencionAjuste[],
  ): Promise<AgregadoParaCalculo[]> {
    const ids = [
      ...new Set(
        intenciones
          .filter((i) => i.accion === 'AGREGAR' && Number.isInteger(i.precioCOId))
          .map((i) => i.precioCOId as number),
      ),
    ];
    if (ids.length === 0) return [];

    const variantes = await cliente.precioCO.findMany({
      where: { id: { in: ids } },
      include: {
        producto: {
          select: {
            nombre: true,
            codigo: true,
            imagenPrincipal: true,
            imagenesProducto: { select: { url: true, colorId: true } },
          },
        },
        talla: { select: { nombre: true } },
        color: { select: { nombre: true } },
        corrida: { select: { nombre: true } },
      },
    });

    const encontradas = new Set(variantes.map((v) => v.id));
    for (const id of ids) {
      if (!encontradas.has(id)) throw new NotFoundException(`PrecioCO ${id} no existe`);
    }

    const columna = await this.precios.columnaParaPedido(pedido);
    return variantes.map((v) => {
      if (v.tiendaId !== pedido.tiendaId) {
        throw new BadRequestException(
          `El producto "${v.producto.nombre}" pertenece a otra tienda.`,
        );
      }
      return {
        precioCOId: v.id,
        productoId: v.productoId,
        productoNombre: v.producto.nombre,
        productoCodigo: v.producto.codigo,
        productoImagen: this.imagenDe(v.producto, v.colorId),
        variante: [v.corrida.nombre, v.talla.nombre, v.color.nombre].filter(Boolean).join(' · '),
        precioBase: precioDeLista(v, columna),
        precioMayoreo: precioDeLista(v, COLUMNA_MAYOREO),
      };
    });
  }

  /**
   * La imagen del color de la variante, con fallback a la principal del producto
   * — el mismo criterio que `SurtidoService.obtenerDetalle`, para que una línea
   * se vea igual en el detalle del pedido y en la propuesta.
   */
  private imagenDe(
    producto: {
      imagenPrincipal: string | null;
      imagenesProducto: Array<{ url: string; colorId: number | null }>;
    } | null,
    colorId: number | null | undefined,
  ): string | null {
    const imagenColor = producto?.imagenesProducto.find((img) => img.colorId === colorId)?.url;
    return this.storage.resolverImagen(imagenColor ?? producto?.imagenPrincipal ?? null);
  }
}
