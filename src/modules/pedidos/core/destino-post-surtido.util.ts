import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * F16 (sep 2026): a dónde va un pedido cuando bodega (o ventas) termina de
 * verificar los productos.
 *
 * Esta decisión vive en UN solo lugar a propósito. La auditoría adversarial
 * encontró que el riesgo más probable de pasar por alto era bifurcar por
 * `modoEntrega` en `confirmarSurtido` pero NO en los caminos de propuesta:
 * un pedido a domicilio con faltante aterrizaría en `REVISADO` y quedaría
 * atorado, porque nadie lo recoge en tienda.
 *
 * La usan los TRES caminos que cierran la verificación de bodega:
 *   - `SurtidoService.confirmarSurtido`      (surtido normal)
 *   - `PropuestaService.aprobarPropuestaBodega`   (el cliente aprobó faltantes)
 *   - `PropuestaService.aprobarPropuestaVentas`   (contrapropuesta sin pendientes)
 *
 * Reglas:
 *   - DOMICILIO → PENDIENTE_PAGO con encolado inmediato a Firebird. El cliente no
 *     está en la tienda, no hay nada que mostrarle. Es el flujo de siempre.
 *   - KIOSKO / RECOGER_TIENDA → REVISADO SIN encolado. El pedido se aparta
 *     y espera a que el cliente lo revise; entra al ERP cuando mostrador lo
 *     libere. Así el ERP sólo ve pedidos que el cliente ya confirmó, y un
 *     ajuste o cancelación en mostrador nunca deja a Firebird desincronizado.
 */
export function destinoTrasSurtido(modoEntrega: ModoEntrega): {
  estado: EstadoPedido;
  encolarFirebird: boolean;
} {
  return modoEntrega === ModoEntrega.DOMICILIO
    ? { estado: EstadoPedido.PENDIENTE_PAGO, encolarFirebird: true }
    : { estado: EstadoPedido.REVISADO, encolarFirebird: false };
}

/**
 * F18 (oct 2026): el destino cuando el surtido quedó INCOMPLETO.
 *
 * El bug que arregla: F17 mandaba el pedido incompleto a `REVISADO` (el área de
 * entrega) con una propuesta `PENDIENTE` — pero toda la maquinaria de aprobación
 * (`resolverPropuesta`) exige `ESPERANDO_APROBACION`. El resultado: **nadie
 * podía responder la propuesta** (ni el cliente, ni el operador, ni el admin) y
 * el cliente nunca se enteraba de que su pedido estaba incompleto.
 *
 * La regla del negocio, decidida con el usuario:
 *
 *   cliente PRESENTE → REVISADO. El de mostrador lo resuelve enfrente: le dice
 *                     qué faltó, ajusta si hace falta y manda a pagar. Los
 *                     cambios de mostrador NO necesitan aprobación del cliente.
 *   cliente AUSENTE  → ESPERANDO_APROBACION. El cliente decide en su app:
 *                     acepta lo que hay, pide un ajuste con un asesor de
 *                     ventas, o cancela.
 *
 * **"Cliente presente" reusa el gate de llegada que ya existe** — el mismo
 * predicado de `obtenerCola` en mostrador: KIOSKO siempre (el pedido se hizo en
 * tienda), WEB solo con aviso vigente. Cero mecanismos nuevos.
 *
 * El caso del cliente que no aprueba y luego llega a tienda se resuelve solo:
 * avisar llegada estando en `ESPERANDO_APROBACION` mueve el pedido a `REVISADO`
 * (arco que ya existe en `TRANSICIONES`), y mostrador lo atiende.
 *
 * DOMICILIO no entra aquí: un pedido a domicilio no pasa por mostrador, así que
 * su faltante se resuelve por el flujo de propuesta async de siempre.
 */
export function destinoTrasSurtidoIncompleto(
  modoEntrega: ModoEntrega,
  clientePresente: boolean,
): {
  estado: EstadoPedido;
  encolarFirebird: boolean;
} {
  if (modoEntrega === ModoEntrega.DOMICILIO) {
    return { estado: EstadoPedido.PENDIENTE_PAGO, encolarFirebird: true };
  }
  return clientePresente
    ? { estado: EstadoPedido.REVISADO, encolarFirebird: false }
    : { estado: EstadoPedido.ESPERANDO_APROBACION, encolarFirebird: false };
}

/**
 * ¿Este pedido tiene al cliente esperando en tienda?
 *
 * F22 (oct 2026): la regla vive en `presencia.util.ts` (una sola para la cola, la
 * TV y bodega) y aquí solo se re-exporta, para no tocar a quien ya la importa.
 * Si divergieran, un pedido podría quedar esperando aprobación con el cliente
 * enfrente, o al revés.
 */
export { clientePresenteEnTienda } from './presencia.util';
