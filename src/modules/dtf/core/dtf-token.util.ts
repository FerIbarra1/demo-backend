import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Impresión DTF — token de "sube tu archivo desde el celular" (el QR de la tablet del kiosko y de la
 * web de escritorio). Ver PLAN-DTF.md §10.
 *
 * Es una CAPACIDAD, no una sesión: quien lo tiene puede SUBIR un archivo a UN borrador durante unos
 * minutos, y nada más (no lista, no descarga, no ve el pedido). El celular no inicia sesión.
 *
 *   "DU1." + base64url(payload) + "." + base64url(hmac[0..15])
 *
 * Mismo esquema que `qr-llegada.util` (HMAC-SHA256 con KIOSKO_QR_SECRET, firma truncada a 128 bits,
 * comparación en tiempo constante) pero con OTRO prefijo y OTRO payload: un token de llegada no sirve
 * aquí ni al revés, aunque compartan secreto.
 *
 * Expira (`e`, segundos epoch): un QR fotografiado por quien está detrás en la fila deja de servir en
 * minutos. Multi-uso dentro de su ventana a propósito: el cliente que se equivoca de archivo y lo
 * vuelve a subir no debería pedir otro QR; el servidor limita versiones y tamaño.
 */
const VERSION = 1;
const PREFIJO = 'DU1.';

export interface SubidaMovilPayload {
  /** Trabajo (borrador) al que se puede subir. */
  t: number;
  /** Dueño del borrador: a quién se le avisa en vivo. */
  u: number;
  /** Expira, en segundos epoch. */
  e: number;
  v: number;
}

export function firmarSubidaMovil(
  trabajoId: number,
  usuarioId: number,
  secret: string,
  opts: { ahora?: Date; vigenciaMin?: number } = {},
): { token: string; expiraAt: Date } {
  const ahora = opts.ahora ?? new Date();
  const expiraAt = new Date(ahora.getTime() + (opts.vigenciaMin ?? 15) * 60_000);
  const payload: SubidaMovilPayload = {
    t: trabajoId,
    u: usuarioId,
    e: Math.floor(expiraAt.getTime() / 1000),
    v: VERSION,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest().subarray(0, 16);
  return { token: `${PREFIJO}${payloadB64}.${sig.toString('base64url')}`, expiraAt };
}

export type VerificacionSubidaMovil =
  | { valido: true; trabajoId: number; usuarioId: number; expiraAt: Date }
  | { valido: false; motivo: 'FORMATO' | 'FIRMA' | 'EXPIRADO' };

export function verificarSubidaMovil(
  token: string,
  secret: string,
  ahora: Date = new Date(),
): VerificacionSubidaMovil {
  if (typeof token !== 'string' || !token.startsWith(PREFIJO)) {
    return { valido: false, motivo: 'FORMATO' };
  }
  const partes = token.slice(PREFIJO.length).split('.');
  if (partes.length !== 2) return { valido: false, motivo: 'FORMATO' };
  const [payloadB64, sigB64] = partes;

  let sigDada: Buffer;
  try {
    sigDada = Buffer.from(sigB64, 'base64url');
  } catch {
    return { valido: false, motivo: 'FORMATO' };
  }
  const sigEsperada = createHmac('sha256', secret).update(payloadB64).digest().subarray(0, 16);
  if (sigDada.length !== sigEsperada.length || !timingSafeEqual(sigDada, sigEsperada)) {
    return { valido: false, motivo: 'FIRMA' };
  }

  let payload: SubidaMovilPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valido: false, motivo: 'FORMATO' };
  }
  if (
    payload.v !== VERSION ||
    !Number.isInteger(payload.t) ||
    !Number.isInteger(payload.u) ||
    !Number.isFinite(payload.e)
  ) {
    return { valido: false, motivo: 'FORMATO' };
  }
  if (payload.e * 1000 <= ahora.getTime()) return { valido: false, motivo: 'EXPIRADO' };
  return {
    valido: true,
    trabajoId: payload.t,
    usuarioId: payload.u,
    expiraAt: new Date(payload.e * 1000),
  };
}
