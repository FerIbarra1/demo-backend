import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, EstadoSurtido } from '@prisma/client';
import { recalcularTotalesPedido } from './totales.util';
import { construirItemPedido } from './item-pedido.util';
import { datosDeRetiroPorDecision, datosDeFaltaDeBodega } from './cancelacion-linea.util';
import { calcularAjusteDeCantidad, piezasEnLaBolsa } from './ajuste-cantidad.util';
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
 *
 * F19 (oct 2026): devuelve también `huboRetiro`, que es OTRA cosa. Ver abajo.
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
): Promise<{
  cambios: string[];
  quedanPendientes: boolean;
  huboRetiro: boolean;
}> {
  const cambios: string[] = [];
  const idsActuales = new Set(itemsActuales.map((i) => i.id));

  /**
   * F19 (oct 2026): ¿se quitó de la bolsa mercancía que YA estaba apartada?
   *
   * Es distinto de `quedanPendientes`. `quedanPendientes` mira el estado FINAL
   * (¿hay algo por surtir?); esto mira si hubo que SACAR algo que ya estaba
   * físicamente en la bolsa del área de entrega.
   *
   * El caso: el asesor quita un producto que bodega había surtido completo. Si
   * además no queda nada pendiente, el pedido iba directo a mostrador —
   * `quedanPendientes` daba false — y la prenda de más se quedaba dentro de la
   * bolsa viajando al área de entrega. El checklist de retiro de bodega, que es
   * justo el mecanismo para sacarla, nunca se disparaba.
   *
   * Es solo la señal de ruteo. NO genera lista de reposición: las piezas las
   * saca el bodeguero y las regresa al anaquel él mismo en el checklist; la
   * reposición es solo de pedidos cancelados o rechazados.
   */
  let huboRetiro = false;

  /** Marca que hay piezas que sacar de la bolsa. */
  const registrarRetiro = (piezas: number) => {
    if (piezas > 0) huboRetiro = true;
  };

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
          piezasRetiradas: true,
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
        // Si bodega había apartado piezas, hay que sacarlas de la bolsa.
        registrarRetiro(piezasEnLaBolsa(item));
        // F20: esta rama SÍ es falta de bodega — el cliente aprobó "lo que hay"
        // y lo que hay es nada. Limpiar el estado físico es correcto aquí: es
        // el único de los caminos de cancelación donde `NO_DISPONIBLE` +
        // `cantidadSurtida: 0` describe literalmente lo que pasó.
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: datosDeFaltaDeBodega(),
        });
        cambios.push(`Item #${it.itemId} quitado del pedido (no disponible)`);
        continue;
      }

      if (item.estadoSurtido === 'PARCIAL') {
        // Se ajusta la cantidad A LO QUE HAY: `cantidad` baja hasta igualar
        // `cantidadSurtida`, así que en la bolsa no sobra nada. Antes esta rama
        // llamaba a `registrarRetiro(cantidadSurtida)` ("el sobrante vuelve al
        // anaquel"), pero no hay sobrante — las piezas que bodega encontró SON
        // las que se lleva el cliente. El resultado era un retiro fantasma: el
        // pedido regresaba a bodega "a retirar de la bolsa" sin nada que retirar
        // y el mensaje al cliente prometía un trabajo que no existe.
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
      // F20 (oct 2026): se CONSERVA su estado físico. Antes se limpiaba
      // (`NO_DISPONIBLE` + `cantidadSurtida: 0`) para que un item cancelado no
      // reapareciera como "faltante" en la siguiente confirmación de bodega —
      // pero eso ya no puede pasar: los guards de `confirmarSurtido` filtran
      // `cancelada` primero (ver `cancelacion-linea.util.ts`). Limpiarlo
      // borraba el hecho de que el producto SÍ estaba en la bolsa, y la
      // pantalla lo mostraba como "No disponible" cuando la verdad era "se
      // cambió por otro".
      if (it.tipo === 'cambio' && idsActuales.has(it.itemId)) {
        // El original pudo estar ya apartado en la bolsa: hay que retirarlo.
        const original = await tx.itemPedido.findUnique({
          where: { id: it.itemId },
          select: { cantidadSurtida: true, piezasRetiradas: true, estadoSurtido: true },
        });
        registrarRetiro(original ? piezasEnLaBolsa(original) : 0);
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: datosDeRetiroPorDecision({
            estadoSurtido: original?.estadoSurtido ?? 'NO_DISPONIBLE',
            cantidadSurtida: original?.cantidadSurtida ?? 0,
          }),
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
      // El asesor quitó un item que bodega pudo haber surtido completo: si hay
      // piezas apartadas, hay que sacarlas de la bolsa.
      //
      // F20 (oct 2026): el nombre del tipo (`no-disponible`) es herencia del
      // modelo viejo y hoy MIENTE — significa "esta línea ya no va", no "no hay
      // mercancía". Por eso se conserva el estado físico: si bodega había
      // apartado 10, la bolsa tiene 10 y el sistema tiene que poder decirlo.
      const previo = await tx.itemPedido.findUnique({
        where: { id: it.itemId },
        select: { cantidadSurtida: true, piezasRetiradas: true, estadoSurtido: true },
      });
      registrarRetiro(previo ? piezasEnLaBolsa(previo) : 0);
      await tx.itemPedido.update({
        where: { id: it.itemId },
        data: datosDeRetiroPorDecision({
          estadoSurtido: previo?.estadoSurtido ?? 'NO_DISPONIBLE',
          cantidadSurtida: previo?.cantidadSurtida ?? 0,
        }),
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
        select: {
          precioUnitario: true,
          cantidad: true,
          cantidadSurtida: true,
          piezasRetiradas: true,
          estadoSurtido: true,
        },
      });
      if (!actual) continue;
      if (nuevaCantidad === 0) {
        // F20: reducir a 0 es una DECISIÓN (el cliente ya no lo quiere), no un
        // faltante. Se conserva el estado físico para poder decir "había 5 y se
        // quitó" en vez de "no había".
        registrarRetiro(piezasEnLaBolsa(actual));
        await tx.itemPedido.update({
          where: { id: it.itemId },
          data: datosDeRetiroPorDecision({
            estadoSurtido: actual.estadoSurtido,
            cantidadSurtida: actual.cantidadSurtida,
          }),
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
      // F21 (oct 2026): el helper conserva `cantidadSurtida` — el hallazgo
      // físico — y reporta el sobrante. Antes esta rama escribía
      // `cantidadSurtida: nuevaCantidad` al bajar, así que un pedido de 5 del
      // que había 3 y el asesor dejó en 1 quedaba con `cantidadSurtida: 1`: la
      // pantalla decía "Disponibles 1" cuando la verdad era "había 3".
      //
      // Espejo de `MostradorService.aplicarAjuste` y del guard de
      // incoherencia de `confirmarSurtido` ("lo que se cobra es lo que se
      // surtió"). Ver `core/ajuste-cantidad.util.ts`.
      //
      // `actual.piezasRetiradas` entra a propósito: si un ajuste anterior ya
      // sacó piezas de la bolsa, subir ahora hasta lo que antes se encontró
      // tampoco está cubierto — esas piezas ya están en el anaquel.
      const ajuste = calcularAjusteDeCantidad(actual, nuevaCantidad);
      // Si baja por debajo de lo que hay en la bolsa, el sobrante lo saca bodega.
      registrarRetiro(ajuste.piezasSobrantes);
      await tx.itemPedido.update({
        where: { id: it.itemId },
        data: {
          ...ajuste.data,
          subtotal: new Prisma.Decimal(actual.precioUnitario).mul(nuevaCantidad),
        },
      });
      cambios.push(
        `Item #${it.itemId} ajustado a ${nuevaCantidad} piezas` +
          (ajuste.subeLaCantidad ? ' (vuelve a bodega a surtir)' : ''),
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
  // pedido vuelve a EN_REVISION para que bodega lo cierre.
  const pendientesRestantes = await tx.itemPedido.count({
    where: {
      pedidoId: pedido.id,
      cancelada: false,
      estadoSurtido: { not: EstadoSurtido.COMPLETO },
    },
  });

  return {
    cambios,
    quedanPendientes: pendientesRestantes > 0,
    huboRetiro,
  };
}
