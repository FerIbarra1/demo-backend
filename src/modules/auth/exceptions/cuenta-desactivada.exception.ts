import { UnauthorizedException } from '@nestjs/common';

/**
 * Excepción para login de un usuario desactivado/eliminado.
 * Incluye un `codigo` que el frontend detecta para mostrar una alerta
 * clara ("contacta a soporte") en lugar del mensaje genérico.
 * El mensaje es neutro por seguridad: no confirma si el email existe.
 */
export class CuentaDesactivadaException extends UnauthorizedException {
  constructor() {
    super(
      'No se pudo iniciar sesión. Si el problema persiste, contacta a soporte.',
    );
  }

  getResponse(): any {
    const response = super.getResponse();
    return {
      ...(typeof response === 'object' && response !== null ? response : {}),
      codigo: 'USUARIO_DESACTIVADO',
    };
  }
}
