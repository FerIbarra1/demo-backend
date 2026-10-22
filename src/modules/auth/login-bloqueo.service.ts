import { Injectable } from '@nestjs/common';
import { LimiteDeIntentos } from '../../common/limite-intentos';

/**
 * Freno de fuerza bruta POR CUENTA: 10 fallos en 10 minutos bloquean el correo hasta que el más viejo caduque. El
 * límite por IP no basta (un atacante reparte los intentos entre IP) y tampoco debe ser el único (una tienda comparte
 * IP). Cuenta también los correos que no existen: si no, el bloqueo sería un oráculo de qué correos tienen cuenta.
 * Compromiso conocido: quien conozca un correo puede bloquearlo 10 minutos (se libera solo; restablecer la contraseña
 * —con el token del correo o desde el panel del admin— también lo libera).
 *
 * UN servicio compartido (no un mapa privado de `AuthService`): el panel del admin es hoy la ÚNICA vía para que un
 * empleado recupere su clave, y un empleado bloqueado seguía recibiendo 429 diez minutos después de que el admin se
 * la restableciera. En memoria y por proceso (una sola instancia): ver `LimiteDeIntentos`.
 */
export const LOGIN_MAX_FALLOS = 10;
export const LOGIN_VENTANA_MS = 10 * 60 * 1000;
export const LOGIN_MAX_CLAVES = 5000;

@Injectable()
export class LoginBloqueoService {
  private readonly fallos = new LimiteDeIntentos({
    maximo: LOGIN_MAX_FALLOS,
    ventanaMs: LOGIN_VENTANA_MS,
    maxClaves: LOGIN_MAX_CLAVES,
  });

  /** El correo en minúsculas y sin espacios: "ANA@x.com" y "ana@x.com" son la misma cuenta para el freno. */
  private clave(email: string): string {
    return email.trim().toLowerCase();
  }

  bloqueado(email: string): boolean {
    return this.fallos.bloqueado(this.clave(email));
  }

  segundosParaLiberar(email: string): number {
    return this.fallos.segundosParaLiberar(this.clave(email));
  }

  /**
   * Anota un intento ANTES de comprobar la contraseña y lo da por fallido hasta que se demuestre lo contrario. El
   * chequeo (`bloqueado`) y esta anotación ocurren seguidos, sin ningún `await` en medio: con N peticiones
   * simultáneas, solo las primeras 10 llegan a gastar un bcrypt; antes, las N pasaban el chequeo y después anotaban.
   */
  registrarIntento(email: string): void {
    this.fallos.registrarFallo(this.clave(email));
  }

  /** El intento no fue un fallo del usuario sino del servidor (la BD): no cuenta contra la cuenta. */
  deshacerIntento(email: string): void {
    this.fallos.deshacerUltimo(this.clave(email));
  }

  /** Un acierto, o una contraseña restablecida: la cuenta queda libre. */
  limpiar(email: string): void {
    this.fallos.limpiar(this.clave(email));
  }
}
