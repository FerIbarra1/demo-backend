import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../modules/auth/dto/register.dto';
import { ChangePasswordDto } from '../modules/auth/dto/update-user.dto';
import { ResetPasswordDto } from '../modules/auth/dto/password-reset.dto';
import { AdminResetPasswordDto, CrearUsuarioDto } from '../modules/usuarios/dto/usuarios.dto';
import { LoginDto } from '../modules/auth/dto/login.dto';
import { PASSWORD_MENSAJE, PASSWORD_MIN } from './password-policy';

/**
 * Oct 2026: UNA política de contraseñas (8 caracteres, una letra y un número) en TODO sitio donde se crea o cambia una.
 * Se prueba contra los DTOs reales —el cableado—, no contra la constante: la prueba que importa es que ningún DTO se
 * quede con su `MinLength(6)` de antes. El LOGIN queda fuera a propósito: las cuentas con 6 caracteres siguen entrando.
 *
 * Los casos son los MISMOS que fija `demo-frontend/scripts/test-password.ts`: si cambias una regla, cambia en los dos.
 */
const FLOJAS = ['123456', 'abcde12', 'abcdefgh', '12345678', ''];
const FUERTES = ['abcdef12', 'Clave-nueva1', 'Mi clave nueva 1!'];

// Cada DTO con el resto de su cuerpo válido, para que el único error posible sea la contraseña.
const sitios: Array<{
  nombre: string;
  campo: string;
  cuerpo: (clave: string) => [new () => object, object];
}> = [
  {
    nombre: 'registro (RegisterDto)',
    campo: 'password',
    cuerpo: (c) => [
      RegisterDto,
      { email: 'a@tienda.com', password: c, nombre: 'Ana', telefono: '+526621234567' },
    ],
  },
  {
    nombre: 'cambio de contraseña (ChangePasswordDto)',
    campo: 'newPassword',
    cuerpo: (c) => [ChangePasswordDto, { oldPassword: 'lo-que-sea', newPassword: c }],
  },
  {
    nombre: 'restablecer con token (ResetPasswordDto)',
    campo: 'newPassword',
    cuerpo: (c) => [ResetPasswordDto, { token: 't', newPassword: c }],
  },
  {
    nombre: 'alta de empleado (CrearUsuarioDto)',
    campo: 'password',
    cuerpo: (c) => [
      CrearUsuarioDto,
      { email: 'e@tienda.com', nombre: 'Eva', password: c, rol: 'CAJERO', tiendaId: 1 },
    ],
  },
  {
    nombre: 'reset por el admin (AdminResetPasswordDto)',
    campo: 'newPassword',
    cuerpo: (c) => [AdminResetPasswordDto, { newPassword: c }],
  },
];

const erroresDe = async (clase: new () => object, cuerpo: object) =>
  validate(plainToInstance(clase, cuerpo));

describe('política de contraseñas', () => {
  it('el mínimo es 8 y el mensaje lo dice', () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MENSAJE).toMatch(/8 caracteres.*letra.*número/);
  });

  describe.each(sitios)('$nombre', ({ campo, cuerpo }) => {
    it.each(FLOJAS)('rechaza %j', async (clave) => {
      const [clase, body] = cuerpo(clave);
      const errores = await erroresDe(clase, body);
      expect(errores.map((e) => e.property)).toContain(campo);
      expect(errores.flatMap((e) => Object.values(e.constraints ?? {}))).toContain(
        PASSWORD_MENSAJE,
      );
    });

    it.each(FUERTES)('acepta %j', async (clave) => {
      const [clase, body] = cuerpo(clave);
      expect(await erroresDe(clase, body)).toHaveLength(0);
    });
  });

  it('el LOGIN no la aplica: una cuenta con contraseña de 6 caracteres sigue entrando', async () => {
    expect(await erroresDe(LoginDto, { email: 'a@tienda.com', password: '123456' })).toHaveLength(
      0,
    );
  });
});
