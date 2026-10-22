import type { TxClient } from './firebird-client';

/**
 * Oct 2026 (parte B) — el FOLIO del Sistema Comercial.
 *
 * El folio de un pedido es un consecutivo de 10 dígitos POR TIENDA que vive en `CONSECUTIVOS` (TIPO = 'PEDIDOS',
 * `CONSECUTIVO` guarda el ÚLTIMO usado). `GRABAR_PEDIDOS` lo toma con exactamente esta sentencia cuando recibe
 * `IDPEDIDO = 0`; la nube y VFP comparten el contador y se turnan sin choques porque el `UPDATE … RETURNING` es atómico
 * (el segundo espera el commit del primero: el agente abre sus transacciones READ COMMITTED + WAIT).
 *
 * Con `IDPEDIDO ≠ 0` (el nuestro: `1 000 000 000 + id`) el procedimiento usa el FOLIO que le pasen y NO toca
 * `CONSECUTIVOS`; por eso el agente lo reserva aparte, cuando la nube lo pide, y lo manda en `GRABAR_PEDIDOS`.
 *
 * No se modifica ningún objeto de Firebird: es la misma sentencia que ya ejecuta el procedimiento.
 */
export const SQL_RESERVAR_FOLIO =
  `UPDATE CONSECUTIVOS SET CONSECUTIVO = CONSECUTIVO + 1 ` +
  `WHERE TIPO = 'PEDIDOS' AND IDTIENDA = ? ` +
  `RETURNING LPAD(CONSECUTIVO, 10, '0') AS FOLIO`;

export const FOLIO_REGEX = /^\d{10}$/;

export function esFolio(valor: unknown): valor is string {
  return typeof valor === 'string' && FOLIO_REGEX.test(valor);
}

/**
 * Toma el siguiente folio de la tienda. Un número tomado no se devuelve: si el pedido luego se cancela queda un hueco en
 * la numeración (el dueño lo aceptó). Lanza si la tienda no tiene su fila en `CONSECUTIVOS`: inventar una crearía una
 * numeración paralela que el Sistema Comercial no conoce.
 */
export async function reservarFolio(tx: Pick<TxClient, 'callScalar'>, idTienda: number): Promise<string> {
  const fila = await tx.callScalar<{ FOLIO?: string }>(SQL_RESERVAR_FOLIO, [idTienda]);
  const folio = String(fila?.FOLIO ?? '').trim();
  if (!folio) {
    throw new Error(`CONSECUTIVOS: la tienda ${idTienda} no tiene consecutivo de PEDIDOS`);
  }
  if (!esFolio(folio)) {
    throw new Error(`CONSECUTIVOS: folio inesperado "${folio}" para la tienda ${idTienda}`);
  }
  return folio;
}

/**
 * Lo que se escribe en `PEDIDOS.NOTAS` (hasta 2000): la marca de origen WEB y el número interno de la nube, antes de las
 * notas del cliente. Es el cruce visible desde el Sistema Comercial (el ID del pedido ya es el folio del ERP; el `PD-…`
 * solo existe en la nube) y deja a la vista de VFP que ese pedido no se tomó en mostrador.
 */
export function notasParaErp(numeroPedido: string, notas: string | null | undefined): string {
  const marca = `WEB ${numeroPedido}`;
  const texto = (notas ?? '').trim();
  return (texto ? `${marca} | ${texto}` : marca).slice(0, 2000);
}

/**
 * ¿El error es un choque de concurrencia sobre la fila de `CONSECUTIVOS`? Firebird 3 contesta "deadlock / update conflicts
 * with concurrent update" (SQLSTATE 40001) al que ESPERABA una fila cuando quien la tenía hizo commit, incluso en READ
 * COMMITTED + WAIT. Se midió contra el Firebird real: con 4 transacciones simultáneas sobre la misma fila, ~30% fallan
 * así. No es un fallo del ERP: es perder el turno, y basta volver a intentar. (VFP convive con lo mismo entre sus cajas.)
 */
export function esConflictoDeConcurrencia(err: unknown): boolean {
  const e = err as { gdscode?: number; message?: string } | null;
  if (!e) return false;
  // isc_deadlock = 335544336, isc_update_conflict = 335544451
  if (e.gdscode === 335544336 || e.gdscode === 335544451) return true;
  return /update conflicts|deadlock/i.test(e.message ?? '');
}

/** Cuántas veces se vuelve a intentar la reserva ante un choque, y la espera base (con jitter) entre intentos. */
export const REINTENTOS_RESERVA = 6;
const ESPERA_BASE_MS = 30;

/**
 * Toma el siguiente folio en su propia transacción corta, reintentando cuando pierde el turno contra otra transacción
 * (VFP u otra reserva). Cada intento es una transacción nueva: tras un conflicto no se reutiliza la anterior. Un error de
 * otro tipo (la tienda sin consecutivo, Firebird caído, el tiempo de espera del bloqueo) sube de inmediato: la nube
 * reintenta la solicitud a los 30 s.
 */
export async function reservarFolioConReintentos(
  fb: { transaction<T>(work: (tx: Pick<TxClient, 'callScalar'>) => Promise<T>, opts?: { waitTimeoutSec?: number }): Promise<T> },
  idTienda: number,
  opts: { waitTimeoutSec?: number; dormir?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const dormir = opts.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let ultimo: unknown;
  for (let intento = 1; intento <= REINTENTOS_RESERVA; intento++) {
    try {
      return await fb.transaction((tx) => reservarFolio(tx, idTienda), { waitTimeoutSec: opts.waitTimeoutSec });
    } catch (err) {
      if (!esConflictoDeConcurrencia(err)) throw err;
      ultimo = err;
      if (intento < REINTENTOS_RESERVA) await dormir(ESPERA_BASE_MS * intento + Math.floor(Math.random() * ESPERA_BASE_MS));
    }
  }
  throw new Error(
    `CONSECUTIVOS: la fila de la tienda ${idTienda} siguió ocupada tras ${REINTENTOS_RESERVA} intentos (${(ultimo as Error)?.message ?? ultimo})`,
  );
}
