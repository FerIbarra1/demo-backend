import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, EstadoSurtido } from '@prisma/client';
import { recalcularTotalesPedido } from './totales.util';
import { construirItemPedido } from './item-pedido.util';
import type { ColumnaLista } from '../../precios/precio-lista.util';
import type { ItemPropuestaJson } from '../propuesta/dto/propuesta.dto';

/**
 * Aplica una propuesta de VENTAS sobre los items del pedido.
 *
 * Se extrajo de `PropuestaService` porque es dominio puro de items: no toca la
 * máquina de estados, ni realtime, ni el ciclo de la propuesta. Recibe una
 * transacción y muta items.
 *
 * La propuesta es un BORRADOR: nada tocó `ItemPedido` hasta este momento.
 *
 * Reglas:
 *   - 'completo'      → no toca nada (el bodeguero ya lo verificó).
 *   - 'parcial'       → ajusta la cantidad del item existente.
 *   - 'no-disponible' → cancela el item.
 *   - 'cambio'        → cancela el original y crea uno nuevo (PENDIENTE).
 *   - 'agregado'      → crea una línea nueva (PENDIENTE).
 *
 * Los items que la propuesta no menciona conservan el `estadoSurtido` que el
 * bodeguero ya había verificado.
 *
 * Devuelve `quedanPendientes`: true si algún item quedó por surtir, lo que
 * determina si el pedido vuelve a bodega o va directo a pago.
 */
export async function aplicarPropuestaDeVentas(
  tx: Prisma.TransactionClient,
  pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
  items: ItemPropuestaJson[],
  itemsActuales: Array<{ id: number; precioUnitario: Prisma.Decimal }>,
  /**
   * Fase 0 (sep 2026): columna de lista de precios DEL CLIENTE que hizo el
   * pedido. Se resuelve en el caller (que tiene `prisma` fuera de la tx) y
   * se pasa aquí porque los productos que el asesor agrega deben congelarse
   * con la lista del cliente, no con `pco.precio` (siempre lista1) ni con la
   * lista del asesor (que no tiene una).
   */
  columnaLista: ColumnaLista,
): Promise<{ cambios: string[]; quedanPendientes: boolean }> {
  const cambios: string[] = [];
  const idsActuales = new Set(itemsActuales.map((i) => i.id));

  for (const it of items) {
    // 'completo' significa "el asesor no tocó este item". Normalmente no hay
    // nada que hacer: bodega ya lo verificó y el cliente lo dejó igual.
    //
    // PERO si bodega lo había marcado con faltante, "completo" es falso: el
    // cliente aprobó LO QUE BODEGA ENCONTRÓ, así que hay que liquidar el item
    // igual que `aplicarCambiosSurtido` (PARCIAL → ajustar cantidad,
    // NO_DISPONIBLE → cancelar). Sin esto el item se queda en faltante y la
    // siguiente confirmación de bodega vuelve a dar 400.
    if (it.tipo === 'completo') {
      if (!idsActuales.has(it.itemId)) continue;
      const item = await tx.itemPedido.findUnique({
        where: { id: it.itemId },
        select: {
          precioUnitario: true,
          cantidadSurtida: true,
          estadoSurtido: true,
          cancelada: true,
        },
      });
      if (!item || item.cancelada) continue;

      // PARCIAL con 0 piezas es, en los hechos, un no disponible.
      const seCancela =
        item.estadoSurtido === 'NO_DISPONIBLE' ||
        (item.estadoSurtido === 'PARCIAL' && item.cantidadSurtida === 0);
      if (seCancela) {
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cancelada: true,
            estadoSurtido: 'NO_DISPONIBLE',
            cantidadSurtida: 0,
          },
        });
        cambios.push(`Item #${it.itemId} quitado del pedido (no disponible)`);
        continue;
      }

      if (item.estadoSurtido === 'PARCIAL') {
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cantidad: item.cantidadSurtida,
            subtotal: new Prisma.Decimal(item.precioUnitario).mul(item.cantidadSurtida),
            estadoSurtido: 'COMPLETO',
          },
        });
        cambios.push(`Item #${it.itemId} ajustado a ${item.cantidadSurtida} piezas (lo que hay)`);
      }
      continue;
    }

    // Items nuevos: 'agregado' (tempId negativo) o 'cambio' (reemplaza uno).
    const esNuevo = it.tipo === 'agregado' || it.tipo === 'cambio';
    if (esNuevo) {
      if (!it.precioCOId) {
        throw new BadRequestException(
          `El item "${it.producto}" (${it.tipo}) requiere precioCOId para poder aplicarse.`,
        );
      }
      const pco = await tx.precioCO.findUnique({
        where: { id: it.precioCOId },
        include: { producto: true, talla: true, color: true, corrida: true },
      });
      if (!pco) {
        throw new NotFoundException(`PrecioCO ${it.precioCOId} no existe`);
      }
      if (pco.tiendaId !== pedido.tiendaId) {
        throw new BadRequestException(`El producto "${it.producto}" pertenece a otra tienda.`);
      }

      // Si es un cambio, cancelar el item original.
      //
      // Se limpia también su estado de surtido: un item cancelado que
      // conserva `PARCIAL`/`NO_DISPONIBLE` reaparece como "faltante" en la
      // siguiente confirmación de bodega y bloquea el pedido para siempre
      // (mismo tratamiento que la rama `no-disponible` de más abajo).
      if (it.tipo === 'cambio' && idsActuales.has(it.itemId)) {
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: {
            cancelada: true,
            estadoSurtido: 'NO_DISPONIBLE',
            cantidadSurtida: 0,
          },
        });
      }

      const cantidad = Math.max(1, it.cantidadNueva ?? it.cantidad);
      // Fase 0: el precio del producto agregado sale de la lista del cliente
      // que hizo el pedido, no de `pco.precio` (lista1).
      //
      // Promo de volumen: se congela el par (base, mayoreo) y el efectivo
      // queda en la base; `recalcularTotalesPedido`, que corre al final de
      // este método, lo ajusta si el pedido llega a 12 piezas contando lo que
      // ya traía más lo que el asesor acaba de agregar.
      await tx.itemPedido.create({
        data: {
          ...construirItemPedido(pco, cantidad, {
            columnaLista,
            original: false,
          }),
          pedidoId: pedido.id,
        },
      });
      cambios.push(
        it.tipo === 'cambio'
          ? `Item #${it.itemId} cambiado por "${pco.producto.nombre}"`
          : `Producto "${pco.producto.nombre}" agregado (${cantidad} pzas)`,
      );
      continue;
    }

    // Items existentes que la propuesta modifica.
    if (!idsActuales.has(it.itemId)) continue;

    if (it.tipo === 'no-disponible') {
      await tx.itemPedido.update({
        where: { id: it.itemId },
        data: { cancelada: true, estadoSurtido: 'NO_DISPONIBLE', cantidadSurtida: 0 },
      });
      cambios.push(`Item #${it.itemId} quitado del pedido`);
      continue;
    }

    if (it.tipo === 'parcial') {
      const nuevaCantidad = Math.max(0, it.cantidadNueva ?? it.cantidad);
      // Se relee del `tx` (no de `itemsActuales`) porque hace falta
      // `cantidadSurtida`, que el caller no carga — y porque dentro de la
      // transacción el valor es el fresco.
      const actual = await tx.itemPedido.findUnique({
        where: { id: it.itemId },
        select: { precioUnitario: true, cantidadSurtida: true },
      });
      if (!actual) continue;
      if (nuevaCantidad === 0) {
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: { cancelada: true, estadoSurtido: 'NO_DISPONIBLE', cantidadSurtida: 0 },
        });
        cambios.push(`Item #${it.itemId} quitado del pedido`);
        continue;
      }
      // La cantidad ajustada tiene que quedar COHERENTE con lo que bodega
      // verificó físicamente. Si el asesor SUBE por encima de lo apartado
      // (bodega tiene 3, propone 5), esas piezas nuevas nadie las verificó:
      // el item vuelve a bodega en PENDIENTE. Si BAJA, lo apartado se ajusta
      // y el sobrante regresa al anaquel.
      //
      // Espejo de `MostradorService.aplicarAjuste` y del guard de
      // incoherencia de `confirmarSurtido` ("lo que se cobra es lo que se
      // surtió").
      const subeLaCantidad = nuevaCantidad > actual.cantidadSurtida;
      await tx.itemPedido.update({
        where: { id: it.itemId },
        data: {
          cantidad: nuevaCantidad,
          subtotal: new Prisma.Decimal(actual.precioUnitario).mul(nuevaCantidad),
          ...(subeLaCantidad
            ? {
                // Hay piezas nuevas que nadie verificó: bodega re-surte.
                estadoSurtido: 'PENDIENTE',
                cantidadSurtida: 0,
              }
            : {
                // Todo lo pedido ya estaba apartado; el sobrante vuelve.
                estadoSurtido: 'COMPLETO',
                cantidadSurtida: nuevaCantidad,
              }),
        },
      });
      cambios.push(
        `Item #${it.itemId} ajustado a ${nuevaCantidad} piezas` +
          (subeLaCantidad ? ' (vuelve a bodega a surtir)' : ''),
      );
    }
  }

  await recalcularTotalesPedido(tx, pedido);

  // F16: guard espejo del de `aplicarCambiosDeBodega`. Sin esto, una
  // propuesta con todos los items no-disponible y sin agregados dejaba el
  // pedido sin productos y avanzaba a pago con subtotal: 0.
  const activos = await tx.itemPedido.count({
    where: { pedidoId: pedido.id, cancelada: false },
  });
  if (activos === 0) {
    throw new BadRequestException(
      'No puedes aprobar esta propuesta: dejaría el pedido sin productos. ' +
        'Cancela el pedido en vez de aprobarlo.',
    );
  }

  // F16: cuenta items no cancelados que NO están en COMPLETO. Si bodega
  // marcó algo como PARCIAL/NO_DISPONIBLE y la propuesta no lo menciona
  // (un asesor que solo editó otros items), el pedido NO puede avanzar
  // — el guard de `confirmarSurtido` nunca se ejecuta en este camino y el
  // invariante "lo que se cobra es lo que se surtió" se rompería. El
  // pedido vuelve a REVIEWING para que bodega lo cierre.
  const pendientesRestantes = await tx.itemPedido.count({
    where: {
      pedidoId: pedido.id,
      cancelada: false,
      estadoSurtido: { not: EstadoSurtido.COMPLETO },
    },
  });

  return { cambios, quedanPendientes: pendientesRestantes > 0 };
}
