import { firmarLlegoQr } from '../../pedidos/core/qr-llegada.util';
import { firmarSubidaMovil, verificarSubidaMovil } from './dtf-token.util';

const SECRETO = 'x'.repeat(40);
const AHORA = new Date('2026-10-17T12:00:00Z');

describe('token de subida desde el celular', () => {
  it('un token recién firmado es válido y dice a qué borrador y de quién', () => {
    const { token, expiraAt } = firmarSubidaMovil(7, 3, SECRETO, { ahora: AHORA, vigenciaMin: 15 });
    const r = verificarSubidaMovil(token, SECRETO, AHORA);
    expect(r).toEqual({ valido: true, trabajoId: 7, usuarioId: 3, expiraAt });
    expect(expiraAt.getTime() - AHORA.getTime()).toBe(15 * 60_000);
  });

  it('expira: un QR fotografiado deja de servir', () => {
    const { token } = firmarSubidaMovil(7, 3, SECRETO, { ahora: AHORA, vigenciaMin: 15 });
    const tarde = new Date(AHORA.getTime() + 15 * 60_000 + 1000);
    expect(verificarSubidaMovil(token, SECRETO, tarde)).toEqual({
      valido: false,
      motivo: 'EXPIRADO',
    });
  });

  it('con otro secreto o con el payload alterado la firma no cuadra', () => {
    const { token } = firmarSubidaMovil(7, 3, SECRETO, { ahora: AHORA });
    expect(verificarSubidaMovil(token, 'y'.repeat(40), AHORA)).toEqual({
      valido: false,
      motivo: 'FIRMA',
    });

    // Cambiar el trabajo del payload (7 → 8) sin la firma correcta.
    const [pref, resto] = [token.slice(0, 4), token.slice(4)];
    const [payloadB64, sig] = resto.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    payload.t = 8;
    const alterado = `${pref}${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verificarSubidaMovil(alterado, SECRETO, AHORA)).toEqual({
      valido: false,
      motivo: 'FIRMA',
    });
  });

  it('un token de LLEGADA no sirve aquí aunque comparta secreto', () => {
    const llegada = firmarLlegoQr(7, 1, SECRETO);
    expect(verificarSubidaMovil(llegada, SECRETO, AHORA)).toEqual({
      valido: false,
      motivo: 'FORMATO',
    });
  });

  it('basura y vacíos se rechazan sin lanzar', () => {
    for (const t of ['', 'DU1.', 'DU1.a', 'DU1.a.b.c', 'hola', undefined as never]) {
      expect(verificarSubidaMovil(t, SECRETO, AHORA).valido).toBe(false);
    }
  });
});
