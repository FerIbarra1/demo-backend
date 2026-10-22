import { ForbiddenException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { LoginBloqueoService } from '../auth/login-bloqueo.service';
import { UsuariosService } from './usuarios.service';

/**
 * Hoy el panel del admin es la ÚNICA vía para que un empleado recupere su clave (no hay pantalla de «olvidé mi
 * contraseña»). Si el empleado se bloqueó por intentos fallidos, la clave nueva tiene que servir YA: antes seguía
 * recibiendo 429 hasta diez minutos después de que el admin se la restableciera.
 */
function armar(usuario: Record<string, unknown> | null) {
  const prisma = {
    usuario: {
      findUnique: jest.fn().mockResolvedValue(usuario),
      update: jest.fn().mockResolvedValue({}),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };
  const bloqueo = new LoginBloqueoService();
  return { svc: new UsuariosService(prisma as never, bloqueo), prisma, bloqueo };
}

const empleado = { id: 4, email: 'Caja@Tienda.com', rol: RolUsuario.CAJERO, deletedAt: null };
const bloquear = (b: LoginBloqueoService, email: string) => {
  for (let i = 0; i < 10; i++) b.registrarIntento(email);
};

describe('UsuariosService.resetPassword', () => {
  it('libera el bloqueo por intentos fallidos del empleado (sin importar mayúsculas del correo)', async () => {
    const { svc, bloqueo } = armar(empleado);
    bloquear(bloqueo, 'caja@tienda.com');
    expect(bloqueo.bloqueado('caja@tienda.com')).toBe(true);

    await svc.resetPassword(4, { newPassword: 'Clave-nueva-1' });

    expect(bloqueo.bloqueado('caja@tienda.com')).toBe(false);
  });

  it('sigue cerrando las sesiones abiertas del empleado', async () => {
    const { svc, prisma } = armar(empleado);
    await svc.resetPassword(4, { newPassword: 'Clave-nueva-1' });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { usuarioId: 4, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('a un CLIENTE no se le restablece desde el panel, y su bloqueo no se toca', async () => {
    const { svc, bloqueo } = armar({ ...empleado, rol: RolUsuario.CLIENTE });
    bloquear(bloqueo, 'caja@tienda.com');
    await expect(svc.resetPassword(4, { newPassword: 'Clave-nueva-1' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(bloqueo.bloqueado('caja@tienda.com')).toBe(true);
  });
});
