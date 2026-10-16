/**
 * Offset con el que el backend pre-asigna el `IDPEDIDO` de Firebird al encolar un
 * pedido (`PedidoStateService.encolarEnvioAFirebird`: `1_000_000_000 + pedidoId`).
 *
 * Los IDs reales de Firebird son < 10M, así que ningún pedido creado directamente en
 * VFP cae en este rango. Eso permite saber —sin mapeo y sin consultar nada— que un
 * `IDPEDIDO` ≥ offset es un pedido que bajó de la nube.
 *
 * Única fuente: `PedidoStateService.encolarEnvioAFirebird` la usa para pre-asignar el ID y
 * `PedidoPagoHandler` para reconocerlo. Antes el literal estaba duplicado en los dos.
 */
export const OFFSET_ID_PEDIDO_NUBE = 1_000_000_000;

/** ¿Este `IDPEDIDO` de Firebird está en el rango que pre-asigna la nube? */
export function esIdPreasignadoPorLaNube(localId: number): boolean {
  return Number.isInteger(localId) && localId >= OFFSET_ID_PEDIDO_NUBE;
}

/** `IDPEDIDO` pre-asignado → id del pedido en la nube. */
export function pedidoIdDesdeIdPreasignado(localId: number): number {
  return localId - OFFSET_ID_PEDIDO_NUBE;
}
