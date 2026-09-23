import { createHmac, timingSafeEqual } from 'crypto';

/**
 * PR7 (kiosko-profesional): HMAC para tokens QR de "avisar llegada".
 *
 * Formato del token:
 *   "PT1." + base64url(payload) + "." + base64url(hmac[0..15])
 *
 * Donde payload es JSON con {pedidoId, tiendaId, v}. La `v` es la
 * versión del token (1); si en el futuro necesitamos rotar (p.ej.
 * ampliar el payload), bumpeamos `v` y el `verificarLlegoQr` rechaza
 * tokens viejos. El admin NO regenera tokens en uso — la rotación es
 * transparente.
 *
 * Decisiones de diseño:
 *  - HMAC-SHA256 con KIOSKO_QR_SECRET (separado de JWT_SECRET). Un
 *    token de bajo valor (señal de cola) no debe compartir secreto
 *    con auth de usuarios.
 *  - Firma truncada a 128 bits (16 bytes). Para este caso de uso basta:
 *    collision resistance 2^64, fuerza bruta imposible contra 128 bits.
 *    Más corto = QR más legible con cámara sucia.
 *  - Multi-uso con rate limit + idempotencia server-side (ver
 *    kiosko-llegada.service). NO single-use: falla en el caso legítimo
 *    "cliente sale a fumar y vuelve" o "tablet se apaga a mitad del
 *    flujo". Un QR de un solo uso genera falsos negativos justo
 *    cuando el cliente está frente al mostrador.
 *  - validateForStore valida tiendaId para que un QR generado en
 *    tienda A no sirva en tienda B.
 */
const VERSION = 1;

export interface LlegoQrPayload {
  pedidoId: number;
  tiendaId: number;
  v: number;
}

export function firmarLlegoQr(pedidoId: number, tiendaId: number, secret: string): string {
  const payload: LlegoQrPayload = { pedidoId, tiendaId, v: VERSION };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig.subarray(0, 16));
  return `PT1.${payloadB64}.${sigB64}`;
}

export interface VerificarLlegoResult {
  valido: boolean;
  pedidoId?: number;
  tiendaId?: number;
}

export function verificarLlegoQr(token: string, secret: string): VerificarLlegoResult {
  if (typeof token !== 'string' || !token.startsWith('PT1.')) return { valido: false };
  const parts = token.split('.');
  if (parts.length !== 3) return { valido: false };
  const [, payloadB64, sigB64] = parts;

  const sigDada = base64urlDecodeToBuffer(sigB64);
  if (!sigDada) return { valido: false };

  const sigEsperada = createHmac('sha256', secret).update(payloadB64).digest().subarray(0, 16);
  if (sigDada.length !== sigEsperada.length) return { valido: false };
  if (!timingSafeEqual(sigDada, sigEsperada)) return { valido: false };

  let payload: LlegoQrPayload;
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64));
  } catch {
    return { valido: false };
  }

  if (payload.v !== VERSION || !Number.isFinite(payload.pedidoId) || !Number.isFinite(payload.tiendaId)) {
    return { valido: false };
  }
  return { valido: true, pedidoId: payload.pedidoId, tiendaId: payload.tiendaId };
}

/** Valida que el token pertenezca a la tienda esperada. Defensa contra
 *  QR generado en tienda A usado en tienda B. */
export function tokenEsDeTienda(token: string, secret: string, tiendaIdEsperado: number): boolean {
  const r = verificarLlegoQr(token, secret);
  return r.valido && r.tiendaId === tiendaIdEsperado;
}

// Helpers base64url — buffer y string. Node 16+ tiene Buffer; evitamos
// dependencias solo por esto.

function base64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64url');
}

function base64urlDecodeToString(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function base64urlDecodeToBuffer(s: string): Buffer | null {
  try {
    return Buffer.from(s, 'base64url');
  } catch {
    return null;
  }
}