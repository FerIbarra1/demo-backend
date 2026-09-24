import { EstadoPedido, ModoEntrega } from '@prisma/client';

/**
 * F16 (sep 2026): a dónde va un pedido cuando bodega (o ventas) termina de
 * verificar los productos.
 *
 * Esta decisión vive en UN solo lugar a propósito. La auditoría adversarial
 * encontró que el riesgo más probable de pasar por alto era bifurcar por
 * `modoEntrega` en `confirmarSurtido` pero NO en los caminos de propuesta:
 * un pedido a domicilio con faltante aterrizaría en `EN_MOSTRADOR` y quedaría
 * atorado, porque nadie lo recoge en tienda.
 *
 * La usan los TRES caminos que cierran la verificación de bodega:
 *   - `SurtidoService.confirmarSurtido`      (surtido normal)
 *   - `PropuestaService.aprobarPropuestaBodega`   (el cliente aprobó faltantes)
 *   - `PropuestaService.aprobarPropuestaVentas`   (contrapropuesta sin pendientes)
 *
 * Reglas:
 *   - DOMICILIO → PENDING_PAID con encolado inmediato a Firebird. El cliente no
 *     está en la tienda, no hay nada que mostrarle. Es el flujo de siempre.
 *   - KIOSKO / RECOGER_TIENDA → EN_MOSTRADOR SIN encolado. El pedido se aparta
 *     y espera a que el cliente lo revise; entra al ERP cuando mostrador lo
 *     libere. Así el ERP sólo ve pedidos que el cliente ya confirmó, y un
 *     ajuste o cancelación en mostrador nunca deja a Firebird desincronizado.
 */
export function destinoTrasSurtido(modoEntrega: ModoEntrega): {
  estado: EstadoPedido;
  encolarFirebird: boolean;
} {
  return modoEntrega === ModoEntrega.DOMICILIO
    ? { estado: EstadoPedido.PENDING_PAID, encolarFirebird: true }
    : { estado: EstadoPedido.EN_MOSTRADOR, encolarFirebird: false };
}
