import { Prisma, EstadoSurtido } from '@prisma/client';

/**
 * F16 (sep 2026): liquidación del estado de los items de un pedido tras
 * surtido (o tras aprobar la propuesta que reemplazó al surtido físico).
 *
 * Es el mismo conjunto de operaciones que aplicaban en paralelo:
 *
 *   - `SurtidoService.aplicarCambiosSurtido`       (cierre de bodega)
 *   - `PropuestaService.aplicarCambiosDeBodega`    (aprobación de propuesta)
 *   - `PropuestaService.aplicarPropuestaDeVentas`  (rama `'completo'`)
 *
 * que divergieron sin razón y produjeron los bugs A–D. Este helper los
 * unifica. Si vuelve a aparecer un cuarto path, debe usar este helper, no
 * copiar el código.
 *
 * Reglas por item:
 *
 *   `NO_DISPONIBLE`         → cancelar y limpiar estado (`cancelada: true`,
 *                              `estadoSurtido: NO_DISPONIBLE`,
 *                              `cantidadSurtida: 0`).
 *
 *   `PARCIAL` con cant=0    → idem (un PARCIAL con 0 piezas es, en los hechos,
 *                              un NO_DISPONIBLE).
 *
 *   `PARCIAL` con cant>0    → ajustar cantidad y subtotal al valor surtido,
 *                              y reescribir `estadoSurtido` a `COMPLETO`.
 *                              Razón: si lo dejamos en PARCIAL, el filtro
 *                              de `confirmarSurtido` lo levanta como faltante
 *                              en la siguiente ronda.
 *
 *   `COMPLETO`              → no entra a `itemsConFaltante`; ya está cerrado.
 *
 *   `PENDIENTE`             → nunca debería llegar aquí: el que llama debe
 *                              haberlo bloqueado aguas arriba (ver
 *                              `confirmarSurtido` y la red de seguridad de
 *                              `aprobarPropuestaBodega`). Si llega, lo
 *                              dejamos tal cual — es mejor que tirar la
 *                              transacción por un 400 que nadie pidió.
 *
 * El caller corre `recalcularTotalesPedido` después.
 */
export interface CambioItem {
  id: number;
  estadoSurtido: EstadoSurtido;
  cantidadSurtida: number;
  motivoSurtido: string | null;
}

export async function aplicarCambiosFisicos(
  tx: Prisma.TransactionClient,
  pedido: { id: number; tiendaId: number; descuento: Prisma.Decimal; impuestos: Prisma.Decimal },
  items: CambioItem[],
): Promise<string[]> {
  const cambios: string[] = [];

  for (const item of items) {
    if (item.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) {
      await tx.itemPedido.update({
        where: { id: item.id },
        data: {
          cancelada: true,
          estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
          cantidadSurtida: 0,
        },
      });
      cambios.push(`Item #${item.id} cancelado (no disponible)`);
      continue;
    }

    if (item.estadoSurtido === EstadoSurtido.PARCIAL) {
      const nuevaCantidad = Math.max(0, item.cantidadSurtida);
      if (nuevaCantidad === 0) {
        await tx.itemPedido.update({
          where: { id: item.id },
          data: {
            cancelada: true,
            estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
            cantidadSurtida: 0,
          },
        });
        cambios.push(`Item #${item.id} cancelado (cantidad 0)`);
        continue;
      }
      const itemActual = await tx.itemPedido.findUnique({ where: { id: item.id } });
      if (!itemActual) throw new Error(`Item ${item.id} no existe`);
      const nuevoSubtotal = new Prisma.Decimal(itemActual.precioUnitario).mul(
        nuevaCantidad,
      );
      await tx.itemPedido.update({
        where: { id: item.id },
        data: {
          cantidad: nuevaCantidad,
          subtotal: nuevoSubtotal,
          estadoSurtido: EstadoSurtido.COMPLETO,
        },
      });
      cambios.push(`Item #${item.id} ajustado a ${nuevaCantidad} piezas`);
    }
  }

  return cambios;
}
