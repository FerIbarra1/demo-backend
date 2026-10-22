/**
 * ¿Este JWT es un token de ACCESO? El refresh token (lleva `jti`) y el del QR del kiosko (lleva `kind`) se firman con
 * el MISMO secreto y también llevan `sub`: sin esta comprobación, `JwtStrategy` aceptaba un refresh token de 7 días
 * como `Authorization: Bearer`, y ese uso no pasa por la tabla `refresh_tokens` (ni la rotación, ni el logout, ni
 * `revocarFamilia` lo frenaban). El token de acceso no lleva ninguno de los dos.
 */
export function esTokenDeAcceso(payload: object | null | undefined): boolean {
  return !!payload && !('jti' in payload) && !('kind' in payload);
}
