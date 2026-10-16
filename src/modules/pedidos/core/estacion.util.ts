/**
 * Oct 2026: cuándo una ESTACIÓN (ventanilla de caja / mostrador) sigue atendida por su operador.
 *
 * El operador manda un latido cada 5 min (`RolShell` → `POST auth/heartbeat`) y al iniciar sesión
 * se marca `lastLogin`. Antes la TV de caja daba por "abierta" una ventanilla si el cajero había
 * entrado en las últimas **12 horas**: quien cerraba la pestaña sin cerrar sesión dejaba su
 * ventanilla "Esperando cliente" medio día, y los clientes caminaban a una ventanilla vacía.
 * Con 15 min (tres latidos) una pausa de red no la cierra, y un abandono sí.
 */
export const INACTIVIDAD_ESTACION_MS = 15 * 60 * 1000;

export interface ActividadOperador {
  lastLogin: Date | null;
  ultimoHeartbeat: Date | null;
}

/** La última señal de vida del operador (la más reciente entre sesión y latido). */
export function ultimaActividad(op: ActividadOperador | null | undefined): Date | null {
  if (!op) return null;
  const a = op.lastLogin?.getTime() ?? 0;
  const b = op.ultimoHeartbeat?.getTime() ?? 0;
  const t = Math.max(a, b);
  return t > 0 ? new Date(t) : null;
}

export function operadorActivo(
  op: ActividadOperador | null | undefined,
  ahora: Date = new Date(),
): boolean {
  const t = ultimaActividad(op);
  return t !== null && ahora.getTime() - t.getTime() <= INACTIVIDAD_ESTACION_MS;
}
