/**
 * Política de contraseñas, UNA sola (oct 2026). Antes cada DTO ponía su `MinLength(6)`: seis caracteres, sin más
 * requisito, para una cuenta que puede ser un ADMIN o Tesorería (que aprueba dinero).
 *
 * Solo aplica al CREAR o CAMBIAR una contraseña; el login no la exige (las cuentas existentes con una de 6 caracteres
 * siguen entrando y se les pide una nueva cuando la cambien).
 */
export const PASSWORD_MIN = 8;
/** Al menos una letra y un número. */
export const PASSWORD_PATRON = /^(?=.*[A-Za-z])(?=.*\d).+$/;
export const PASSWORD_MENSAJE = `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres, con al menos una letra y un número`;
