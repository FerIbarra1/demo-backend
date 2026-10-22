import { Prisma, EstadoSurtido } from '@prisma/client';

/**
 * F20 (oct 2026): las DOS razones por las que una línea sale del pedido, y por
 * qué hay que distinguirlas.
 *
 * `ItemPedido` guarda dos hechos distintos que hasta ahora se pisaban:
 *
 *   `cancelada`      → ¿la línea sigue participando en el pedido? (DINERO)
 *   `estadoSurtido`  → ¿qué encontró bodega en el anaquel?        (FÍSICO)
 *
 * Los caminos que sacaban una línea escribían SIEMPRE el mismo trío
 * (`cancelada: true`, `estadoSurtido: NO_DISPONIBLE`, `cantidadSurtida: 0`),
 * sin importar la razón. Eso borraba el hecho físico en el caso donde seguía
 * siendo cierto:
 *
 *   El cliente pidió 10 camisetas X, bodega las apartó TODAS (COMPLETO, 10 en
 *   la bolsa) y después el cliente decidió quitarlas del pedido. El sistema
 *   escribía `NO_DISPONIBLE` + `cantidadSurtida: 0` — o sea "no había nada" —
 *   cuando la verdad era "había 10 y se retiraron". En pantalla el producto
 *   salía con el badge "No disponible" y el monto tachado, como si fuera un
 *   faltante de inventario.
 *
 * La distinción se puede DERIVAR de lo que ya existe, sin columna nueva:
 *
 *   cancelada && cantidadSurtida > 0   → se retiró, y SÍ había piezas
 *   cancelada && cantidadSurtida === 0 → bodega no la encontró
 *
 * Eso es exactamente lo que leen las pantallas (ver `cantidadesItem.ts` en el
 * frontend). Lo único que hace falta es que el dato no se destruya al cancelar.
 */

/**
 * La línea sale porque BODEGA NO LA ENCONTRÓ.
 *
 * Es el único caso donde limpiar el estado físico es correcto: no hay nada en
 * la bolsa que conservar, y `NO_DISPONIBLE` + `cantidadSurtida: 0` es
 * literalmente lo que pasó.
 *
 * Lo usan: el cierre de surtido (`aplicarCambiosFisicos`), la rama
 * `'completo'` de la propuesta de ventas cuando bodega ya había marcado
 * faltante, y la red de seguridad de `aprobarPropuestaBodega`.
 */
export function datosDeFaltaDeBodega(): Prisma.ItemPedidoUpdateInput {
  return {
    cancelada: true,
    estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
    cantidadSurtida: 0,
  };
}

/**
 * La línea sale por una DECISIÓN, no por falta de mercancía.
 *
 * Cubre los cuatro casos donde alguien decidió que la línea no va:
 *   - el cliente/asesor la quitó (`no-disponible`)
 *   - la cambió por otro producto (`cambio`)
 *   - la redujo a 0 piezas (`parcial` con cantidad 0)
 *   - el operador de mostrador la quitó en el ajuste POS
 *
 * En los cuatro el hallazgo físico SIGUE SIENDO CIERTO y se conserva: si
 * bodega apartó 10 piezas, la bolsa tiene 10 y el sistema tiene que poder
 * decirlo — tanto para que el bodeguero sepa cuánto sacar
 * (`obtenerAjustesEntrega`) como para que el cliente vea que sí había.
 *
 * `cantidad` se deja intacta a propósito: es la cantidad VIGENTE y el
 * recálculo de totales solo suma items con `cancelada: false`, así que una
 * línea cancelada no aporta al dinero pase lo que pase.
 *
 * SEGURIDAD: conservar `estadoSurtido` en una línea cancelada NO rompe ningún
 * guard. Los cinco que leen ese campo filtran `cancelada` primero:
 * `surtido.service.ts` (PENDIENTE, faltantes, conteo de activos),
 * `aplicar-propuesta-ventas.util.ts` (`pendientesRestantes`) y
 * `propuesta-bodega.util.ts` (conteo de piezas). Verificado uno por uno.
 */
export function datosDeRetiroPorDecision(item: {
  estadoSurtido: EstadoSurtido;
  cantidadSurtida: number;
}): Prisma.ItemPedidoUpdateInput {
  return {
    cancelada: true,
    // El hecho físico sobrevive: esto es lo que permite distinguir "lo quitó"
    // de "no había" sin una columna nueva.
    estadoSurtido: item.estadoSurtido,
    cantidadSurtida: item.cantidadSurtida,
  };
}

/**
 * ¿Esta línea se retiró teniendo piezas apartadas?
 *
 * Es el predicado que separa "el cliente la quitó y sí había" de "no había
 * nada". Lo consume `huboRetiro` (para mandar el pedido a bodega a sacar la
 * mercancía de la bolsa) y lo consumirá la UI para elegir el badge.
 *
 * Se deriva de las cantidades y no de `estadoSurtido` porque el estado puede
 * ser `COMPLETO` (bodega la surtió entera) o `PARCIAL` (surtió parte): en los
 * dos casos hay algo que sacar de la bolsa.
 */
export function seRetiraronPiezas(item: { cancelada: boolean; cantidadSurtida: number }): boolean {
  return item.cancelada && item.cantidadSurtida > 0;
}

/**
 * Oct 2026 (propuestas, decisión 3): ¿esta línea se puede REPONER?
 *
 * Una línea "sin existencia" es la que BODEGA no encontró y por eso salió del
 * pedido: es exactamente lo que escribe `datosDeFaltaDeBodega()` (cancelada +
 * `NO_DISPONIBLE` + `cantidadSurtida: 0`). El dueño pidió que se pueda volver a
 * meter —llegó mercancía, o bodega se equivocó—: reponerla es DESHACER esa salida,
 * no crear una línea nueva. Reponer la línea original conserva lo que importa:
 * "Pediste 5" (`cantidadPedida`), el par de precios congelado y el rastro de que
 * hubo un faltante. Agregar la misma variante como producto nuevo duplicaba el
 * renglón y falseaba el "Pediste".
 *
 * Las tres condiciones importan, y la última es la que separa esto de un retiro:
 *
 *   - `cancelada`            — si está viva no hay nada que reponer.
 *   - `NO_DISPONIBLE`        — solo lo que bodega marcó. Una línea que alguien
 *                              QUITÓ conserva el estado que tenía (ver
 *                              `datosDeRetiroPorDecision`), y una que se cambió
 *                              por otra (`cambio`) ya tiene su reemplazo.
 *   - `cantidadSurtida === 0`— no hay piezas en la bolsa ni en reposición que
 *                              deshacer. Una línea retirada con piezas apartadas
 *                              ya tiene trabajo en marcha (el checklist de bodega o
 *                              la lista de reposición) y reponerla chocaría con él.
 *
 * Es el espejo de `estaSinExistencia` del frontend.
 */
export function sePuedeReponer(item: {
  cancelada: boolean;
  estadoSurtido: EstadoSurtido;
  cantidadSurtida: number;
}): boolean {
  return (
    item.cancelada &&
    item.estadoSurtido === EstadoSurtido.NO_DISPONIBLE &&
    item.cantidadSurtida === 0
  );
}

/**
 * El `data` que devuelve una línea sin existencia al pedido.
 *
 * Nace como cualquier línea que nadie ha visto en el anaquel: `PENDIENTE` con
 * `cantidadSurtida: 0`, así que el pedido tiene que pasar por bodega a verificarla.
 * `cantidad` y `subtotal` los pone el caller (necesita el precio de la línea).
 * `cantidadPedida` NO se toca: sigue siendo lo que el cliente pidió.
 */
export function datosDeReposicion(): Prisma.ItemPedidoUpdateInput {
  return {
    cancelada: false,
    estadoSurtido: EstadoSurtido.PENDIENTE,
    cantidadSurtida: 0,
    piezasRetiradas: 0,
  };
}
