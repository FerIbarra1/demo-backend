import { BadRequestException } from '@nestjs/common';
import { EstadoSurtido, Prisma } from '@prisma/client';
import { PIEZAS_MAYOREO, precioConPromoVolumen } from '../../precios/precio-lista.util';
import { piezasEnLaBolsa } from './ajuste-cantidad.util';
import { sePuedeReponer } from './cancelacion-linea.util';
import type { ItemPropuestaJson } from '../propuesta/dto/propuesta.dto';

/**
 * Oct 2026 (Fase 2): LA calculadora de ajuste. Una sola función que decide qué
 * dice una propuesta y cuánto cuesta, para los tres sitios que antes lo
 * calculaban cada uno por su cuenta:
 *
 *   - bodega, al cerrar un surtido incompleto (`construirPropuestaDeBodega`);
 *   - el asesor de ventas, al armar su contrapropuesta;
 *   - el editor del asesor y del operador, para mostrar filas y total.
 *
 * El problema de fondo que resuelve: el SNAPSHOT que el cliente lee para decidir
 * lo armaba el navegador del asesor, y el servidor solo recalculaba el total.
 * Eran dos números que podían no coincidir, y lo hacían:
 *
 *   - las filas del editor no sumaban su propio total (precio congelado vs
 *     re-evaluado);
 *   - un producto AGREGADO no llevaba la promo de volumen en la propuesta pero sí
 *     en el cobro ($854 mostrado, $836 cobrado);
 *   - el servidor guardaba tal cual lo que mandara el navegador, y al aprobar
 *     aplicaba otra cosa leída de la BD.
 *
 * Ahora el cliente de la API manda su INTENCIÓN —"esta línea a 3", "quita esta",
 * "agrega esta variante"— y el servidor, que conoce el pedido y los precios,
 * arma las líneas, el total y los avisos. Es el mismo principio que F17 aplicó a
 * bodega ("el bodeguero marca, el sistema decide"), extendido a ventas.
 *
 * Es dominio PURO: no toca la BD ni el storage. El caller (`AjusteService`)
 * carga los items y resuelve las variantes que se agregan.
 *
 * Las reglas de dinero no se reinventan aquí: el precio sale de
 * `precioConPromoVolumen`, la MISMA función que usan la creación del pedido, el
 * carrito y `aplicarPromoVolumen` (el cobro), con el total de piezas FINAL.
 */

/**
 * Lo que el usuario quiere hacer con el pedido. Una intención por línea.
 *
 *   CANTIDAD  esta línea queda en N piezas (N ≥ 1; para sacarla usa QUITAR).
 *   QUITAR    esta línea sale del pedido.
 *   AGREGAR   agrega N piezas de una variante que el pedido no tiene.
 *   REPONER   (oct 2026) una línea que BODEGA no encontró vuelve al pedido con N
 *             piezas. Deshace la salida en vez de crear una línea nueva: conserva
 *             el "Pediste N" y el precio congelado. Solo vale sobre una línea
 *             "sin existencia" (`sePuedeReponer`).
 *
 * Una línea SIN intención no se toca. Una CANTIDAD igual a la que ya tiene
 * tampoco: se descarta, no cuenta como cambio.
 */
export interface IntencionAjuste {
  accion: 'CANTIDAD' | 'QUITAR' | 'AGREGAR' | 'REPONER';
  /** CANTIDAD, QUITAR y REPONER: el item del pedido. */
  itemId?: number;
  /** AGREGAR: la variante del catálogo. */
  precioCOId?: number;
  /** CANTIDAD, AGREGAR y REPONER: piezas finales de la línea. */
  cantidad?: number;
}

/**
 * Un item activo del pedido, con lo que la calculadora necesita saber de él.
 *
 * Sirve para las DOS entradas: items ya colapsados (el pedido que el asesor o el
 * operador están editando) y items tal como los deja el bodeguero ANTES de
 * liquidar el surtido (PARCIAL / NO_DISPONIBLE), que es lo que recibe
 * `construirPropuestaDeBodega`. La regla de cuántas piezas quedan
 * (`cantidadSinIntencion`) cubre las dos.
 */
export interface ItemParaCalculo {
  id: number;
  productoNombre: string;
  /** Viaja al snapshot: el personal identifica la prenda por su código. */
  productoCodigo: string;
  /** Ya resuelta por el caller (la calculadora no toca el storage). */
  productoImagen?: string | null;
  productoId?: number | null;
  /** La variante, para impedir que se "agregue" una que el pedido ya tiene. */
  precioCOId?: number | null;
  corridaNombre: string;
  tallaNombre: string;
  colorNombre: string;
  /** F19: la cantidad PEDIDA (inmutable). Ver `ItemPedido.cantidadPedida`. */
  cantidadPedida: number;
  cantidad: number;
  cantidadSurtida: number;
  /** Piezas que un ajuste anterior ya sacó de la bolsa (F21). */
  piezasRetiradas?: number | null;
  estadoSurtido: EstadoSurtido;
  precioUnitario: Prisma.Decimal | number;
  precioUnitarioBase: Prisma.Decimal | number | null;
  precioUnitarioMayoreo: Prisma.Decimal | number | null;
  subtotal: Prisma.Decimal | number;
  cancelada: boolean;
}

/**
 * Una variante que se agrega, ya resuelta contra el catálogo por el caller.
 *
 * Los dos precios son los que `construirItemPedido` va a CONGELAR en el item al
 * aprobar (`precioDeLista` de la lista del cliente y de la lista 2). Calcular
 * aquí con los mismos números es lo que hace que el precio de la propuesta sea el
 * del cobro, y no el que mandara el navegador.
 */
export interface AgregadoParaCalculo {
  precioCOId: number;
  productoId: number;
  productoNombre: string;
  productoCodigo: string;
  productoImagen?: string | null;
  /** "Corrida · Talla · Color", igual que las líneas existentes. */
  variante: string;
  precioBase: Prisma.Decimal;
  precioMayoreo: Prisma.Decimal;
}

export interface ResultadoAjuste {
  /** El snapshot que se guarda en la propuesta y que el cliente lee. */
  items: ItemPropuestaJson[];
  /** Lo que se cobraría: solo lo que sobrevive, al precio con la promo re-evaluada. */
  total: number;
  /** Lo que valía el pedido antes de este ajuste, o `null` si no tenía líneas. */
  totalAntes: number | null;
  /** Piezas que tendría el pedido después de aplicarlo. */
  piezasFinales: number;
  /** De esas, cuántas bodega todavía no ha visto (exceden lo que hay en la bolsa). */
  piezasPorSurtir: number;
  /** ¿Hay al menos una decisión efectiva? Una propuesta sin cambios no se envía. */
  hayCambios: boolean;
  /**
   * El precio de mayoreo depende de piezas que bodega aún no ha visto: si no las
   * encuentra, el pedido baja de 12 y el precio se recalcula.
   */
  mayoreoCondicional: boolean;
}

/** Cuántas piezas quedarían si nadie decide nada sobre esta línea. */
function cantidadSinIntencion(it: ItemParaCalculo): number {
  if (it.cancelada) return 0;
  if (it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE) return 0;
  if (it.estadoSurtido === EstadoSurtido.PARCIAL) return Math.max(0, it.cantidadSurtida);
  return Math.max(0, it.cantidad);
}

/** Une corrida · talla · color. */
function varianteDe(
  it: Pick<ItemParaCalculo, 'corridaNombre' | 'tallaNombre' | 'colorNombre'>,
): string {
  return [it.corridaNombre, it.tallaNombre, it.colorNombre].filter(Boolean).join(' · ');
}

const num = (d: Prisma.Decimal): number => Number(d);

/** Valida las intenciones y las separa por tipo. Falla con un mensaje que dice qué corregir. */
function validarIntenciones(
  items: ItemParaCalculo[],
  intenciones: IntencionAjuste[],
  agregados: Map<number, AgregadoParaCalculo>,
): { porItem: Map<number, IntencionAjuste>; agregar: IntencionAjuste[] } {
  const activos = new Map(items.filter((i) => !i.cancelada).map((i) => [i.id, i]));
  // Las líneas que bodega no encontró: las únicas sobre las que vale REPONER.
  const reponibles = new Map(items.filter(sePuedeReponer).map((i) => [i.id, i]));
  const variantesDelPedido = new Set(
    [...activos.values()].map((i) => i.precioCOId).filter((id): id is number => id != null),
  );
  const porItem = new Map<number, IntencionAjuste>();
  const agregar: IntencionAjuste[] = [];
  const agregadosVistos = new Set<number>();

  for (const it of intenciones) {
    if (it.accion === 'AGREGAR') {
      if (!Number.isInteger(it.precioCOId)) {
        throw new BadRequestException('Un producto agregado requiere la variante (precioCOId).');
      }
      if (!Number.isInteger(it.cantidad) || (it.cantidad as number) < 1) {
        throw new BadRequestException('Un producto agregado necesita al menos 1 pieza.');
      }
      const precioCOId = it.precioCOId as number;
      if (variantesDelPedido.has(precioCOId)) {
        throw new BadRequestException(
          'Esa variante ya está en el pedido: cambia la cantidad de su línea en vez de agregarla otra vez.',
        );
      }
      if (agregadosVistos.has(precioCOId)) {
        throw new BadRequestException('La misma variante viene agregada dos veces.');
      }
      if (!agregados.has(precioCOId)) {
        throw new BadRequestException(
          `La variante ${precioCOId} no se pudo resolver en el catálogo.`,
        );
      }
      agregadosVistos.add(precioCOId);
      agregar.push(it);
      continue;
    }

    // REPONER opera sobre una línea que bodega no encontró (no sobre una viva).
    if (it.accion === 'REPONER') {
      if (!Number.isInteger(it.itemId) || !reponibles.has(it.itemId as number)) {
        throw new BadRequestException(
          `El item ${it.itemId ?? '(sin id)'} no se puede reponer: solo vuelven las líneas ` +
            'que bodega marcó sin existencia.',
        );
      }
      if (!Number.isInteger(it.cantidad) || (it.cantidad as number) < 1) {
        throw new BadRequestException('Reponer una línea necesita al menos 1 pieza.');
      }
      if (porItem.has(it.itemId as number)) {
        throw new BadRequestException(`El item ${it.itemId} viene con dos cambios a la vez.`);
      }
      porItem.set(it.itemId as number, it);
      continue;
    }

    // CANTIDAD | QUITAR operan sobre una línea existente.
    if (!Number.isInteger(it.itemId) || !activos.has(it.itemId as number)) {
      throw new BadRequestException(
        `El item ${it.itemId ?? '(sin id)'} no pertenece al pedido o ya no está activo.`,
      );
    }
    const itemId = it.itemId as number;
    if (porItem.has(itemId)) {
      throw new BadRequestException(`El item ${itemId} viene con dos cambios a la vez.`);
    }
    if (it.accion === 'CANTIDAD') {
      if (!Number.isInteger(it.cantidad) || (it.cantidad as number) < 1) {
        throw new BadRequestException(
          'La cantidad debe ser un entero mayor a 0. Para sacar la línea del pedido usa QUITAR.',
        );
      }
    }
    porItem.set(itemId, it);
  }

  return { porItem, agregar };
}

/**
 * Calcula el resultado de aplicar `intenciones` a `items`.
 *
 * Con `intenciones` vacías describe el pedido tal como está —es lo que hace
 * `construirPropuestaDeBodega` con el surtido que acaba de cerrar bodega—.
 */
export function calcularAjuste(
  items: ItemParaCalculo[],
  intenciones: IntencionAjuste[],
  agregadosResueltos: AgregadoParaCalculo[] = [],
): ResultadoAjuste {
  const agregadosPorId = new Map(agregadosResueltos.map((a) => [a.precioCOId, a]));
  const { porItem, agregar } = validarIntenciones(items, intenciones, agregadosPorId);
  const vivos = items.filter((i) => !i.cancelada);
  // Las líneas que bodega no encontró y el usuario decidió reponer. NO están en
  // `vivos` (siguen canceladas hasta que se aplique el ajuste), pero cuentan para el
  // tamaño final del pedido y salen en el snapshot como cualquier otra línea.
  const reponidos = items.filter((i) => porItem.get(i.id)?.accion === 'REPONER');

  // 1) Cuántas piezas queda en cada línea. Una CANTIDAD igual a la actual no es
  //    una decisión: se descarta.
  const decisiones = new Map<number, IntencionAjuste>();
  const finalDe = new Map<number, number>();
  for (const it of vivos) {
    const sinIntencion = cantidadSinIntencion(it);
    const intencion = porItem.get(it.id);
    if (intencion?.accion === 'QUITAR') {
      decisiones.set(it.id, intencion);
      finalDe.set(it.id, 0);
    } else if (intencion?.accion === 'CANTIDAD' && intencion.cantidad !== sinIntencion) {
      decisiones.set(it.id, intencion);
      finalDe.set(it.id, intencion.cantidad as number);
    } else {
      finalDe.set(it.id, sinIntencion);
    }
  }
  for (const it of reponidos) {
    const intencion = porItem.get(it.id) as IntencionAjuste;
    decisiones.set(it.id, intencion);
    finalDe.set(it.id, intencion.cantidad as number);
  }
  // Las líneas del snapshot, en el orden del pedido: la repuesta vuelve a su lugar.
  const paraLineas = [...vivos, ...reponidos].sort((a, b) => a.id - b.id);

  // 2) El tamaño FINAL del pedido decide la promo. En una sola pasada saldrían
  //    precios mezclados (las primeras líneas a base, las últimas a mayoreo).
  const piezasAgregadas = agregar.reduce((acc, a) => acc + (a.cantidad as number), 0);
  const piezasFinales =
    paraLineas.reduce((acc, it) => acc + (finalDe.get(it.id) ?? 0), 0) + piezasAgregadas;

  /**
   * Precio de una pieza con la promo re-evaluada al tamaño final. Si el item no
   * trae el par congelado (pedido anterior a la promo de sep 2026) se usa su
   * precio actual: `aplicarPromoVolumen` tampoco lo tocaría.
   */
  const precioEfectivo = (it: ItemParaCalculo): Prisma.Decimal => {
    if (it.precioUnitarioBase == null) return new Prisma.Decimal(it.precioUnitario);
    const base = new Prisma.Decimal(it.precioUnitarioBase);
    const mayoreo = new Prisma.Decimal(it.precioUnitarioMayoreo ?? base);
    return precioConPromoVolumen(base, mayoreo, piezasFinales);
  };

  const lineas: ItemPropuestaJson[] = [];
  let total = new Prisma.Decimal(0);
  let totalAntes = new Prisma.Decimal(0);
  let piezasPorSurtir = 0;

  // 3) Las líneas que el pedido ya tiene, en el mismo orden.
  for (const it of paraLineas) {
    const variante = varianteDe(it);
    const final = finalDe.get(it.id) ?? 0;
    const decision = decisiones.get(it.id);
    const pedida = it.cantidadPedida;
    const precioCongelado = num(new Prisma.Decimal(it.precioUnitario));
    const subtotalAntes = new Prisma.Decimal(it.subtotal);
    // Una línea repuesta no estaba cobrándose antes de este ajuste (salió del pedido
    // cuando bodega no la encontró): no suma a lo que el pedido valía.
    if (decision?.accion !== 'REPONER') totalAntes = totalAntes.plus(subtotalAntes);

    const comunes = {
      itemId: it.id,
      producto: it.productoNombre,
      productoCodigo: it.productoCodigo,
      productoImagen: it.productoImagen ?? null,
      productoId: it.productoId ?? undefined,
      variante,
      subtotalOriginal: num(subtotalAntes),
    };

    // Oct 2026 (decisión 3): una línea que bodega no encontró vuelve al pedido.
    //
    // Se describe como un `parcial` —"Pediste 5 · Hay 0 · Te llevas 3"— porque eso es
    // lo que es: la cantidad pedida y el hallazgo (0) no cambian, lo nuevo es la
    // decisión. Lo que bodega todavía tiene que surtir son TODAS sus piezas (nadie
    // las ha visto). El aplicador reconoce la reposición por el estado de la línea
    // en la BD (`sePuedeReponer`), no por una marca del snapshot.
    if (decision?.accion === 'REPONER') {
      const precio = precioEfectivo(it);
      total = total.plus(precio.mul(final));
      piezasPorSurtir += final;
      lineas.push({
        ...comunes,
        // Antes de este ajuste la línea NO estaba en el pedido, así que no aportaba
        // nada a lo que el pedido valía. El frontend suma `subtotalOriginal` para
        // decir "antes de estos cambios" (igual que `totalAntes`): con lo que valía
        // cuando se pidió ese total saldría inflado respecto a lo que se cobra, y
        // la línea se leería como una baja siendo un aumento.
        subtotalOriginal: 0,
        tipo: 'parcial',
        cantidad: pedida,
        precioUnitario: precioCongelado,
        subtotal: 0,
        productoOriginal: it.productoNombre,
        varianteOriginal: variante,
        cantidadOriginal: pedida,
        ajusteExplicito: true,
        productoNuevo: it.productoNombre,
        varianteNueva: variante,
        cantidadNueva: final,
        // Bodega no encontró nada: el número del medio sigue siendo 0.
        cantidadDisponible: 0,
        precioUnitarioNuevo: num(precio),
        subtotalNuevo: num(precio.mul(final)),
        piezasPorSurtir: final,
      });
      continue;
    }

    // La línea sale del pedido: por decisión (QUITAR) o porque bodega no la
    // encontró. No se cobra, y su `subtotal` es 0 en los dos casos; lo que
    // valía va en `subtotalOriginal`. La causa la distingue `ajusteExplicito`.
    const bodegaNoLaEncontro = !decision && it.estadoSurtido === EstadoSurtido.NO_DISPONIBLE;
    if (decision?.accion === 'QUITAR' || bodegaNoLaEncontro) {
      lineas.push({
        ...comunes,
        tipo: 'no-disponible',
        cantidad: pedida,
        precioUnitario: precioCongelado,
        cantidadOriginal: pedida,
        // Lo que HABÍA: el hallazgo físico se conserva si fue una decisión
        // (había piezas y se quitaron) y es 0 si bodega no encontró nada.
        cantidadDisponible: decision ? it.cantidadSurtida : 0,
        ajusteExplicito: decision != null,
        subtotal: 0,
      });
      continue;
    }

    const precio = precioEfectivo(it);
    total = total.plus(precio.mul(final));
    const porSurtir = piezasPorSurtirDe(final, it);
    piezasPorSurtir += porSurtir;
    const marcaPorSurtir = porSurtir > 0 ? { piezasPorSurtir: porSurtir } : {};

    if (decision || final !== pedida) {
      // Cambió algo: o alguien decidió una cantidad, o bodega encontró una
      // distinta a la pedida (PARCIAL, o ya colapsada). El cliente aprueba la
      // cantidad REAL, no la pedida.
      lineas.push({
        ...comunes,
        tipo: 'parcial',
        cantidad: pedida,
        precioUnitario: precioCongelado,
        subtotal: num(subtotalAntes),
        productoOriginal: it.productoNombre,
        varianteOriginal: variante,
        cantidadOriginal: pedida,
        ajusteExplicito: decision != null,
        productoNuevo: it.productoNombre,
        varianteNueva: variante,
        cantidadNueva: final,
        // F21: el número del medio, "Hay N". Es HALLAZGO aunque la decisión lo
        // iguale; la tarjeta lo necesita para distinguir una observación de bodega
        // de un ajuste posterior.
        cantidadDisponible: it.cantidadSurtida,
        precioUnitarioNuevo: num(precio),
        subtotalNuevo: num(precio.mul(final)),
        ...marcaPorSurtir,
      });
      continue;
    }

    // Sin cambios. Se incluye para que el cliente vea el pedido entero (lo que sí
    // llegó), no solo los cambios — con el precio re-evaluado, no el congelado.
    lineas.push({
      ...comunes,
      tipo: 'completo',
      cantidad: pedida,
      precioUnitario: num(precio),
      subtotal: num(precio.mul(final)),
      ...marcaPorSurtir,
    });
  }

  // 4) Los productos que se agregan: tempId negativo, en el orden en que llegaron.
  agregar.forEach((a, idx) => {
    const v = agregadosPorId.get(a.precioCOId as number) as AgregadoParaCalculo;
    const cantidad = a.cantidad as number;
    const precio = precioConPromoVolumen(v.precioBase, v.precioMayoreo, piezasFinales);
    total = total.plus(precio.mul(cantidad));
    piezasPorSurtir += cantidad;
    const tempId = -(idx + 1);
    lineas.push({
      itemId: tempId,
      tempId,
      tipo: 'agregado',
      producto: v.productoNombre,
      productoCodigo: v.productoCodigo,
      productoImagen: v.productoImagen ?? null,
      productoId: v.productoId,
      precioCOId: v.precioCOId,
      variante: v.variante,
      cantidad,
      precioUnitario: num(precio),
      subtotal: num(precio.mul(cantidad)),
      // Nadie lo ha visto en el anaquel: todas sus piezas las surte bodega.
      piezasPorSurtir: cantidad,
    });
  });

  // 5) El aviso del mayoreo condicional.
  const hayMayoreoPosible =
    paraLineas.some(
      (it) =>
        it.precioUnitarioBase != null &&
        it.precioUnitarioMayoreo != null &&
        new Prisma.Decimal(it.precioUnitarioMayoreo).lessThan(it.precioUnitarioBase),
    ) || [...agregadosPorId.values()].some((a) => a.precioMayoreo.lessThan(a.precioBase));
  const mayoreoCondicional = mayoreoDependeDeBodega(
    piezasFinales,
    piezasPorSurtir,
    hayMayoreoPosible,
  );
  if (mayoreoCondicional) {
    for (const l of lineas) l.mayoreoCondicional = true;
  }

  return {
    items: lineas,
    total: num(total),
    totalAntes: vivos.length > 0 ? num(totalAntes) : null,
    piezasFinales,
    piezasPorSurtir,
    hayCambios: decisiones.size + agregar.length > 0,
    mayoreoCondicional,
  };
}

/**
 * Cuántas piezas de esta línea tiene que surtir bodega para cumplir `final`.
 *
 * Lo que excede lo que HAY en la bolsa (lo encontrado menos lo que un ajuste
 * anterior ya sacó) nadie lo ha visto contra el anaquel. Una línea PENDIENTE
 * (cantidadSurtida 0) pide todas sus piezas.
 */
function piezasPorSurtirDe(final: number, it: ItemParaCalculo): number {
  if (final <= 0) return 0;
  const enBolsa = piezasEnLaBolsa({
    cantidadSurtida: it.cantidadSurtida,
    piezasRetiradas: it.piezasRetiradas,
  });
  return Math.max(0, final - enBolsa);
}

/**
 * ¿El precio de mayoreo de este pedido depende de piezas que bodega todavía no ha
 * visto?
 *
 * La promo (12+ piezas) se aplica de una vez con lo que se propone, aunque esas
 * piezas no estén verificadas. Es lo correcto —el cliente tiene que ver el
 * precio que pagaría— pero quien decide tiene que saber que es condicional: si
 * bodega no encuentra las piezas nuevas, el pedido baja del umbral y el precio se
 * recalcula al cerrar el surtido.
 *
 * Solo avisa cuando QUITAR las piezas sin verificar dejaría el pedido bajo el
 * umbral. Si el pedido ya llega a 12 con piezas que están en la bolsa, la promo
 * no depende de nadie y el aviso sería ruido.
 *
 * `hayMayoreoPosible`: algún precio de mayoreo es MÁS BARATO que su base. Un
 * cliente de lista 3..6 no se beneficia (su base ya es más barata), y avisarle
 * sería inventar una promo.
 */
export function mayoreoDependeDeBodega(
  piezasFinales: number,
  piezasSinVerificar: number,
  hayMayoreoPosible: boolean,
): boolean {
  return (
    hayMayoreoPosible &&
    piezasSinVerificar > 0 &&
    piezasFinales >= PIEZAS_MAYOREO &&
    piezasFinales - piezasSinVerificar < PIEZAS_MAYOREO
  );
}
