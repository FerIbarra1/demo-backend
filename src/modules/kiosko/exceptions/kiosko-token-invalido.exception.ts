import { UnauthorizedException } from '@nestjs/common';

/**
 * El device token del kiosko falta, está mal formado o no coincide con el
 * hash guardado. Es un fallo de CREDENCIALES: la tablet no puede probar
 * que es ella.
 *
 * Se distingue de `KioskoInactivoException` (409) porque el frontend debe
 * reaccionar distinto: aquí el admin tiene que regenerar el token y
 * pegarlo en la tablet; allí basta con volver a activar el kiosko.
 */
export class KioskoTokenInvalidoException extends UnauthorizedException {
  constructor() {
    super('X-Kiosko-Token inválido o kiosko sin token configurado');
  }

  getResponse(): any {
    const response = super.getResponse();
    return {
      ...(typeof response === 'object' && response !== null ? response : {}),
      codigo: 'KIOSKO_TOKEN_INVALIDO',
    };
  }
}
