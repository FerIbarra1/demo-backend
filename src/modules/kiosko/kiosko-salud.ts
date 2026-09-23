/**
 * Salud de un kiosko, derivada de su estado y de su último latido.
 *
 * Existe para que el panel del admin distinga de un vistazo qué tablets
 * requieren acción. Antes todo se veía como "Inactivo" o "Caído" sin
 * distinción, y el admin no sabía si un kiosko apagado era una decisión suya
 * o una tablet que se murió.
 *
 * Se calcula en el BACKEND (no en el frontend) para que todos los clientes
 * coincidan y las reglas vivan en un solo lugar.
 */
export type SaludKiosko =
  /** Late con normalidad. */
  | 'SANA'
  /** Late, pero con retraso (red lenta, tablet saturada). Aún no es alarma. */
  | 'LATIDO_LENTO'
  /** Debería latir y no lo hace: la tablet se apagó, se cayó o perdió red. */
  | 'CAIDA'
  /** El admin la apagó a propósito. No requiere acción. */
  | 'APAGADO_ADMIN'
  /** Dada de alta pero la tablet nunca se ha conectado. */
  | 'PENDIENTE_INSTALAR'
  /** Activa pero sin credencial: la tablet necesita re-vincularse. */
  | 'SIN_CREDENCIAL';

/** Un latido más viejo que esto se considera caída. */
const UMBRAL_CAIDA_MS = 10 * 60 * 1000;
/** Entre 3 y 10 minutos: late con retraso, pero todavía no es alarma. */
const UMBRAL_LENTO_MS = 3 * 60 * 1000;

interface KioskoParaSalud {
  estado: string;
  ultimoHeartbeat: Date | null;
  primerConexionAt: Date | null;
  desactivadoAt: Date | null;
  deviceTokenHash: string | null;
}

/**
 * Deriva la salud de un kiosko. Es una función PURA: recibe `ahora` para que
 * sea determinista y testeable (nada de `Date.now()` interno).
 */
export function calcularSaludKiosko(
  kiosko: KioskoParaSalud,
  ahora: number,
): SaludKiosko {
  // El admin lo apagó: es una decisión, no una falla. Se revisa PRIMERO porque
  // un kiosko apagado no debe reportarse como caído aunque no lata.
  if (kiosko.estado !== 'ACTIVO') {
    // `desactivadoAt` es el criterio correcto para "el admin lo apagó": un
    // kiosko puede estar INACTIVO sin haberse instalado nunca (alta recién
    // creada) o haberse apagado después de operar. `primerConexionAt` no
    // sirve para distinguirlo — un kiosko que operó y se apagó puede tenerlo
    // en null si su primer latido nunca se registró.
    return kiosko.desactivadoAt ? 'APAGADO_ADMIN' : 'PENDIENTE_INSTALAR';
  }

  // Activo pero sin credencial: la tablet no puede operar hasta re-vincularse.
  if (!kiosko.deviceTokenHash) {
    return 'SIN_CREDENCIAL';
  }

  if (!kiosko.ultimoHeartbeat) {
    // Activo, con credencial, pero nunca ha latido: la tablet no ha abierto la
    // app todavía (o el binding se guardó pero la tablet no arrancó).
    return 'PENDIENTE_INSTALAR';
  }

  const desdeUltimoLatido = ahora - kiosko.ultimoHeartbeat.getTime();
  if (desdeUltimoLatido > UMBRAL_CAIDA_MS) return 'CAIDA';
  if (desdeUltimoLatido > UMBRAL_LENTO_MS) return 'LATIDO_LENTO';
  return 'SANA';
}

/** ¿Esta salud requiere que el admin haga algo? */
export function requiereAccion(salud: SaludKiosko): boolean {
  return salud === 'CAIDA' || salud === 'SIN_CREDENCIAL';
}

export interface ResumenSalud {
  total: number;
  sanas: number;
  /** Caídas + sin credencial: lo que el admin debe atender. */
  requierenAtencion: number;
  /** Apagadas a propósito + pendientes de instalar: no son fallas. */
  inactivas: number;
}

/** Agrega el conteo por salud para los tiles del panel. */
export function resumirSalud(
  kioskos: Array<{ salud: SaludKiosko }>,
): ResumenSalud {
  let sanas = 0;
  let latidoLento = 0;
  let requierenAtencion = 0;
  let inactivas = 0;

  for (const k of kioskos) {
    switch (k.salud) {
      case 'SANA':
        sanas++;
        break;
      case 'LATIDO_LENTO':
        latidoLento++;
        break;
      case 'CAIDA':
      case 'SIN_CREDENCIAL':
        requierenAtencion++;
        break;
      case 'APAGADO_ADMIN':
      case 'PENDIENTE_INSTALAR':
        inactivas++;
        break;
    }
  }

  return {
    total: kioskos.length,
    // `LATIDO_LENTO` cuenta como sana para el resumen: aún no requiere acción,
    // y sumarlo a "atención" generaría ruido por redes lentas.
    sanas: sanas + latidoLento,
    requierenAtencion,
    inactivas,
  };
}
