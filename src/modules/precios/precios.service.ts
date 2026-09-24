import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ColumnaLista,
  resolverColumnaLista,
} from './precio-lista.util';

/**
 * Fase 0 (sep 2026): resuelve qué lista de precios le toca a un cliente.
 *
 * Es la ÚNICA fuente de verdad de esa decisión. La consumen:
 *   - `CatalogoService` — para mostrar el precio correcto en pantalla.
 *   - `ClienteService`  — para CONGELAR ese precio al crear el pedido.
 *   - `PropuestaService`— para congelarlo al agregar productos en una
 *                         propuesta (bodega o ventas).
 *
 * Antes esta consulta vivía privada en `CatalogoService`, así que el pedido se
 * creaba con `PrecioCO.precio` (siempre `lista1`) sin importar la lista del
 * cliente. Ver `precio-lista.util.ts` para el detalle del bug.
 *
 * El módulo es `@Global()` porque la consumen tres módulos de dominios
 * distintos y no tiene estado propio — importarlo en cada uno solo agregaría
 * ruido de wiring.
 */
@Injectable()
export class PreciosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Columna de lista del usuario para una tienda concreta.
   *
   * Precedencia: `UsuarioTienda.listaPrecioCodigo` (por sucursal, activa) →
   * `Usuario.listaPrecioCodigo` (global) → `lista1`.
   *
   * Sin `usuarioId` (visitante anónimo, o caller que no tiene el dato) cae a
   * `lista1`, igual que el catálogo público.
   */
  async columnaParaUsuario(
    usuarioId?: number,
    tiendaId?: number,
  ): Promise<ColumnaLista> {
    if (!usuarioId) return 'lista1';

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: {
        listaPrecioCodigo: true,
        tiendasCliente: tiendaId
          ? {
              where: { tiendaId, activo: true },
              select: { listaPrecioCodigo: true },
            }
          : undefined,
      },
    });

    return resolverColumnaLista(
      usuario?.tiendasCliente?.[0]?.listaPrecioCodigo,
      usuario?.listaPrecioCodigo,
    );
  }

  /**
   * Igual que `columnaParaUsuario` pero partiendo del PEDIDO.
   *
   * Es el método que deben usar los caminos de ajuste: el precio siempre lo
   * determina la lista del cliente que hizo el pedido, NUNCA la de quien lo
   * está ajustando (un asesor de ventas o un operador de mostrador no tienen
   * lista de precios de cliente).
   */
  async columnaParaPedido(
    pedido: { usuarioId: number; tiendaId: number },
  ): Promise<ColumnaLista> {
    return this.columnaParaUsuario(pedido.usuarioId, pedido.tiendaId);
  }
}
