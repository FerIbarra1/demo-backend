import { RolUsuario } from '@prisma/client';
import { nombreDeActor } from './nombre-actor';

/**
 * PLAN-ADMIN-MULTITIENDA §4.5.3 (oct 2026): cuando el ADMIN actúa en la consola de una tienda, cada línea
 * del historial dice QUIÉN lo hizo, y no puede confundirse con un empleado de esa tienda. "Llamado por
 * Fernando" parecía un operador más; "por Fernando (Administrador)" no.
 */
describe('nombreDeActor', () => {
  it('al ADMIN se le agrega su rol: no se confunde con un empleado', () => {
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: 'Fernando' })).toBe(
      'Fernando (Administrador)',
    );
  });

  it('a un empleado no se le toca el nombre', () => {
    for (const rol of Object.values(RolUsuario).filter(
      (r) => r !== RolUsuario.ADMIN && r !== RolUsuario.GERENTE,
    )) {
      expect(nombreDeActor({ rol, nombre: 'Ana' })).toBe('Ana');
    }
  });

  it('al GERENTE se le pone su rol (supervisa y actúa sobre pedidos de su tienda: la bitácora debe decirlo), sin repetirlo', () => {
    expect(nombreDeActor({ rol: RolUsuario.GERENTE, nombre: 'Ana' })).toBe('Ana (Gerente)');
    expect(nombreDeActor({ rol: RolUsuario.GERENTE, nombre: 'Gerente Mexicali' })).toBe(
      'Gerente Mexicali',
    );
    expect(nombreDeActor({ rol: RolUsuario.GERENTE, nombre: '' })).toBe('Gerente');
  });

  it('si el nombre ya lo dice no se repite ("Administrador (Administrador)")', () => {
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: 'Administrador' })).toBe('Administrador');
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: 'Admin Sistema' })).toBe('Admin Sistema');
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: 'Fernando (Administrador)' })).toBe(
      'Fernando (Administrador)',
    );
  });

  it('no inventa un nombre: sin nombre queda el rol', () => {
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: '' })).toBe('Administrador');
    expect(nombreDeActor({ rol: RolUsuario.ADMIN, nombre: '   ' })).toBe('Administrador');
  });
});
