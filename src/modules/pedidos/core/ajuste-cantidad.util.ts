import { Prisma, EstadoSurtido } from '@prisma/client';

/**
 * F21 (oct 2026): LOS TRES NÚMEROS de una línea del pedido, y por qué el ajuste
 * de cantidad no puede pisar ninguno.
 *
 * El bug que esto arregla, reportado desde el piso:
 *
 *   "El cliente pidió 5, hay 3, y en el ajuste pidió bajar a 1 de las 3 que hay.
 *    El sistema me dice que se solicitaron 5 pero que solo hay 1 disponible, y
 *    eso no es cierto."
 *
 * La causa era escribir `cantidadSurtida: cantidadNueva` al bajar la cantidad:
 * con 3 en el anaquel y una decisión de 1, el item quedaba con
 * `cantidadSurtida: 1` y la pantalla —que lee ese campo como "lo que hay"— decía
 * "Disponibles 1". El hecho físico se destruía.
 *
 * Cada columna guarda UN hecho y ninguno se pisa:
 *
 *   `cantidadPedida`  → lo que el cliente PIDIÓ. Inmutable (F19).
 *   `cantidadSurtida` → lo que BODEGA ENCONTRÓ en el anaquel. Hallazgo físico.
 *   `cantidad`        → lo que el cliente SE LLEVA. Es lo que se cobra, lo que
 *                       viaja al ERP y lo que leen los totales.
 *
 * Con los tres, la pantalla puede decir "Pediste 5 · Hay 3 · Te llevas 1" — que
 * es la única lectura que no miente. Y cuando no hubo ajuste, `cantidad` y
 * `cantidadSurtida` coinciden, así que el tercer número no se muestra: no hay
 * nada que aclarar.
 *
 * Es el hermano de `cancelacion-linea.util.ts`: aquél distingue las razones por
 * las que una línea SALE del pedido; éste gobierna lo que pasa cuando la línea
 * se QUEDA pero cambia de tamaño.
 */

/** Lo mínimo que hay que saber de un item para ajustarle la cantidad. */
export interface ItemParaAjuste {
  /** La cantidad VIGENTE (lo que se cobra hoy). */
  cantidad: number;
  /** El hallazgo físico de bodega. NO se toca. */
  cantidadSurtida: number;
  /**
   * Piezas que el bodeguero YA sacó de la bolsa en un ajuste anterior.
   *
   * Opcional (default 0) para los callers que no lo leen. Con él se sabe cuántas
   * piezas hay REALMENTE en la bolsa: `cantidadSurtida - piezasRetiradas`. Sin
   * descontarlo, un segundo ajuste que SUBE la cantidad dentro de lo que se
   * encontró (había 5, se sacaron 2, el cliente ahora quiere 4) se daba por
   * cubierto con piezas que ya están en el anaquel: el item quedaba COMPLETO con
   * 3 en la bolsa y el cliente pagaba 4.
   */
  piezasRetiradas?: number;
  estadoSurtido: EstadoSurtido;
}

export interface ResultadoAjuste {
  /** El `data` del `itemPedido.update`. */
  data: Prisma.ItemPedidoUpdateInput;
  /**
   * El ajuste pide MÁS piezas de las que bodega verificó.
   *
   * Es la señal de que hay que devolver el item a bodega a surtir lo nuevo —
   * nadie ha visto esas piezas contra el anaquel. El caller la usa para decirle
   * al bodeguero qué va a encontrar (`quedanPendientes`).
   */
  subeLaCantidad: boolean;
  /**
   * Cuántas piezas quedan de MÁS en la bolsa y alguien tiene que sacar.
   *
   * 0 cuando el ajuste sube o deja la cantidad igual. Sin esto, bajar de 5 a 3
   * dejaba 2 prendas dentro de la bolsa viajando al área de entrega sin que nadie
   * las sacara. Quién las saca depende de quién ajusta:
   *
   *   - VENTAS: el pedido vuelve a bodega y el bodeguero las saca con el checklist
   *     de retiro y las regresa al anaquel él mismo. NO hay reposición.
   *   - MOSTRADOR (oct 2026): las saca el operador enfrente del cliente y pasan a
   *     reposición (`ReposicionService.registrarQuitadasEnMostrador`); el pedido
   *     solo viaja a bodega si además hay algo que surtir.
   *
   * En los dos casos el caller suma estas piezas a `piezasRetiradas` cuando
   * quedan fuera de la bolsa, para que el checklist no vuelva a pedirlas.
   */
  piezasSobrantes: number;
}

/**
 * Calcula el `data` de un ajuste de cantidad, conservando el hallazgo físico.
 *
 * Las tres ramas, y por qué cada una escribe lo que escribe:
 *
 *   BAJA (3 → 1)  `cantidad` = 1, `cantidadSurtida` = 3 (INTACTA), COMPLETO.
 *                 Las 2 que sobran vuelven al anaquel. El item sigue COMPLETO
 *                 porque lo que se lleva YA estaba verificado: no hay nada que
 *                 bodega tenga que revisar.
 *
 *   SUBE (3 → 7)  `cantidad` = 7, PENDIENTE, y la línea se REBASA a lo que hay en
 *                 la bolsa: `cantidadSurtida` = 3, `piezasRetiradas` = 0 y
 *                 `piezasBase` = 3. Bodega verifica SOLO las 4 de más (decisión 2 del
 *                 dueño, oct 2026); las 3 que ya están en la bolsa no se vuelven a
 *                 contar.
 *
 *                 Antes la línea se reiniciaba entera (`cantidadSurtida` = 0) y
 *                 bodega re-verificaba las 7, cuando 3 ya estaban físicamente en la
 *                 bolsa del área de entrega. Rebasar a la bolsa (y no conservar el
 *                 hallazgo original) mantiene la cuenta simple: con `piezasRetiradas`
 *                 en 0, "lo que hay en la bolsa" y `cantidadSurtida` vuelven a ser la
 *                 misma cifra para todo el que lee la línea. El hallazgo histórico se
 *                 pierde, pero ya se había descartado antes: el reinicio lo borraba.
 *
 *                 `piezasBase` es el PISO de lo que bodega puede marcar (nunca menos
 *                 de 3) y no se puede derivar: en cuanto marca, `cantidadSurtida` pasa
 *                 a ser el total. Ver la columna en `schema.prisma`.
 *
 *   IGUAL         no se llama: el caller ya filtró que no hay cambio.
 *
 * La asimetría es deliberada: al BAJAR el hallazgo es un hecho histórico que hay
 * que conservar (nadie vuelve a mirar el anaquel); al SUBIR se rebasa a lo que hay
 * en la bolsa y bodega suma lo que encuentre encima.
 *
 * **Invariante que hay que sostener:** `cantidadSurtida` significa siempre "lo
 * que bodega encontró en el anaquel" y NUNCA se escribe con una decisión. Los
 * guards que dependen de él (`confirmarSurtido`, `aplicarCambiosFisicos`,
 * `obtenerAjustesEntrega`) siguen leyendo la verdad.
 */
export function calcularAjusteDeCantidad(
  item: ItemParaAjuste,
  cantidadNueva: number,
): ResultadoAjuste {
  const cantidad = Math.max(0, cantidadNueva);
  // Lo que HAY en la bolsa: lo encontrado menos lo que el bodeguero ya sacó. La
  // comparación contra `cantidadSurtida` a secas daba por buenas piezas que ya
  // volvieron al anaquel (ver `ItemParaAjuste.piezasRetiradas`).
  const enBolsa = Math.max(0, item.cantidadSurtida - (item.piezasRetiradas ?? 0));
  const subeLaCantidad = cantidad > enBolsa;

  if (subeLaCantidad) {
    return {
      data: {
        cantidad,
        // Bodega todavía tiene que verificar lo que excede la bolsa.
        estadoSurtido: EstadoSurtido.PENDIENTE,
        // REBASE: el hallazgo pasa a ser lo que HAY en la bolsa. Las piezas que un
        // ajuste anterior sacó ya no cuentan: están en el anaquel, y bodega las
        // volvería a traer como si fueran nuevas (que es exactamente lo que son).
        cantidadSurtida: enBolsa,
        // `piezasRetiradas` cuenta piezas contra el hallazgo de `cantidadSurtida`;
        // al rebasarlo el conteo vuelve a 0. Si no, la siguiente baja restaría un
        // retiro de una ronda anterior y el bodeguero nunca recibiría el checklist
        // de las piezas que de verdad sobran.
        piezasRetiradas: 0,
        // El piso: bodega no puede marcar menos de lo que ya está en la bolsa.
        piezasBase: enBolsa,
      },
      subeLaCantidad: true,
      piezasSobrantes: 0,
    };
  }

  return {
    data: {
      cantidad,
      // INTACTA a propósito: es "lo que hay", no "lo que se lleva".
      cantidadSurtida: item.cantidadSurtida,
      // Todo lo que se lleva ya estaba verificado: no vuelve a bodega.
      estadoSurtido: EstadoSurtido.COMPLETO,
      // La línea ya no espera nada de bodega (puede venir de una subida que aún no
      // se surtía): sin esto el piso viejo bloquearía marcarla más abajo.
      piezasBase: 0,
    },
    subeLaCantidad: false,
    piezasSobrantes: Math.max(0, enBolsa - cantidad),
  };
}

/**
 * Oct 2026 (propuestas, decisión 4): ¿este ajuste de MOSTRADOR tiene algo que
 * bodega deba surtir?
 *
 * Es la pregunta que decide si el pedido viaja a bodega o se resuelve en el lugar.
 * Si el cliente solo QUITA o BAJA piezas, el operador las saca él enfrente del
 * cliente, pasan a reposición y no hay nada que bodega tenga que ver: mandar el
 * pedido a la cola solo hacía esperar al cliente que está de pie en la tienda.
 * Bodega entra únicamente cuando hay piezas que nadie ha verificado contra el
 * anaquel: un producto AGREGADO o una cantidad que SUBE por encima de lo que hay en
 * la bolsa.
 *
 * Usa `calcularAjusteDeCantidad` para las líneas con cambio de cantidad, a
 * propósito: es la MISMA función que decide qué se escribe, así que la decisión de
 * "va a bodega" y el dato que queda en la línea no pueden contradecirse. Y es la
 * misma vara que `piezasPorSurtir` de la calculadora del editor (lo que sobra sobre
 * `piezasEnLaBolsa`), que es lo que el frontend lee para anunciarlo antes de enviar.
 *
 * Las líneas SIN cambio también cuentan: una línea viva con más cantidad que piezas
 * en la bolsa (un PENDIENTE que nadie ha surtido) no puede quedarse en el área de
 * entrega, o llegaría al ERP cobrando mercancía que bodega nunca vio.
 */
export function ajusteNecesitaBodega(
  actuales: Array<ItemParaAjuste & { id: number; cancelada: boolean }>,
  cambios: Array<{
    tipo: 'completo' | 'parcial' | 'no-disponible' | 'agregado' | 'reponer';
    itemId?: number;
    cantidad?: number;
  }>,
): boolean {
  // Un producto agregado y una línea repuesta son lo mismo para bodega: piezas que
  // nadie ha visto en el anaquel.
  if (cambios.some((c) => c.tipo === 'agregado' || c.tipo === 'reponer')) return true;

  const cambioPorItem = new Map(
    cambios.filter((c) => c.tipo !== 'completo' && c.itemId != null).map((c) => [c.itemId!, c]),
  );

  return actuales.some((item) => {
    if (item.cancelada) return false;
    const cambio = cambioPorItem.get(item.id);
    // La línea sale del pedido: no hay nada que surtir de ella.
    if (cambio?.tipo === 'no-disponible') return false;
    if (cambio?.tipo === 'parcial') {
      // Mismo piso de 1 que `aplicarAjuste`.
      return calcularAjusteDeCantidad(item, Math.max(1, cambio.cantidad ?? 1)).subeLaCantidad;
    }
    return item.cantidad > piezasEnLaBolsa(item);
  });
}

/**
 * ¿Cuántas piezas de esta línea ya no van en la bolsa y el bodeguero tiene que
 * sacar?
 *
 * Dos caminos, y los dos son "mercancía apartada que ya no va en el pedido":
 *
 *   - la línea se CANCELÓ teniendo piezas apartadas (`cancelada` + hallazgo)
 *   - la línea SIGUE pero se le BAJÓ la cantidad (sobra el excedente)
 *
 * El segundo caso es el que faltaba: bajar de 5 a 3 dejaba 2 prendas dentro de
 * la bolsa viajando al área de entrega sin que nadie las sacara.
 *
 * Se deriva de las cantidades y no de una columna nueva: `cantidad` es lo que se
 * lleva y `cantidadSurtida` lo que hay, así que "hay más de lo que se lleva" ES
 * el sobrante. Ver `calcularAjusteDeCantidad`.
 *
 * OJO: esto NO es reposición. Estas piezas las saca el bodeguero de la bolsa y
 * las regresa al anaquel él mismo mientras hace el ajuste (checklist de retiro);
 * no generan trabajo posterior. La reposición es de pedidos cancelados o
 * rechazados y de lo que el operador de MOSTRADOR quita enfrente del cliente
 * (que ya no pasa por el checklist: ver `piezasPendientesDeRetiro`).
 */
export function piezasFueraDeLaBolsa(item: {
  cancelada: boolean;
  cantidad: number;
  cantidadSurtida: number;
}): number {
  if (item.cantidadSurtida <= 0) return 0;
  // Cancelada: sale todo lo que había.
  if (item.cancelada) return item.cantidadSurtida;
  // Activa pero reducida: sale el excedente.
  return Math.max(0, item.cantidadSurtida - item.cantidad);
}

/**
 * F21 (oct 2026): lo que TODAVÍA falta sacar de la bolsa.
 *
 * `piezasFueraDeLaBolsa` es posicional: deriva el sobrante de comparar
 * `cantidadSurtida` con `cantidad`. El problema es que sacar las prendas de la
 * bolsa NO cambia ninguna de las dos columnas — el bodeguero marca el checklist
 * en estado local del sheet y ese estado se pierde al cerrarlo. Si el pedido
 * vuelve a bodega por un segundo ajuste, el predicado reporta otra vez las
 * mismas prendas y el bodeguero va a buscar mercancía que ya sacó.
 *
 * Esta función resta el hecho registrado (`piezasRetiradas`, que se incrementa
 * al confirmar el surtido) de lo que el predicado posicional calcula. Es la
 * fuente única de "qué falta por hacer", y es la que gobiernan la tarjeta de
 * ajustes y el checklist de retiro del sheet.
 *
 * `piezasFueraDeLaBolsa` se CONSERVA sin tocar: es el total histórico.
 */
export function piezasPendientesDeRetiro(item: {
  cancelada: boolean;
  cantidad: number;
  cantidadSurtida: number;
  piezasRetiradas: number;
}): number {
  return Math.max(0, piezasFueraDeLaBolsa(item) - item.piezasRetiradas);
}

/**
 * Cuántas piezas de esta línea HAY físicamente en la bolsa ahora mismo.
 *
 * Es lo encontrado menos lo que el bodeguero ya sacó. Es la cantidad que tiene
 * que volver al anaquel si el pedido se CANCELA (`ReposicionService.crearDesdePedido`):
 * lo que un ajuste anterior ya sacó el bodeguero lo regresó él, y listarlo otra
 * vez en reposición era el bug de "los productos que ya acomodé vuelven a salir".
 *
 * Aplica igual a líneas canceladas por un ajuste (se quitó el producto entero):
 * si el bodeguero ya lo sacó, `piezasRetiradas === cantidadSurtida` y da 0.
 */
export function piezasEnLaBolsa(item: {
  cantidadSurtida: number;
  piezasRetiradas?: number | null;
}): number {
  return Math.max(0, item.cantidadSurtida - (item.piezasRetiradas ?? 0));
}
