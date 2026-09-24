import { ConflictException } from '@nestjs/common';

/**
 * El kiosko existe y el device token es correcto, pero el kiosko está
 * INACTIVO (el admin lo desactivó).
 *
 * Es un CONFLICTO DE ESTADO, no un fallo de credenciales — de ahí el 409
 * en lugar del 401. Antes ambos casos devolvían 401 y el frontend no podía
 * distinguir "el token venció" de "el admin apagó el kiosko", así que
 * mostraba el mismo mensaje para dos problemas con soluciones distintas.
 */
export class KioskoInactivoException extends ConflictException {
  constructor() {
    super('El kiosko está inactivo');
  }

  getResponse(): any {
    const response = super.getResponse();
    return {
      ...(typeof response === 'object' && response !== null ? response : {}),
      codigo: 'KIOSKO_INACTIVO',
    };
  }
}
