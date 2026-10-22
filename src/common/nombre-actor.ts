import { RolUsuario } from '@prisma/client';

/**
 * Cómo se NOMBRA a quien actúa, para el historial, los avisos y los eventos (PLAN-ADMIN-MULTITIENDA §4.5.3).
 *
 * El ADMIN opera las consolas de cualquier tienda con su propia identidad (no hay "ver como": rompería la
 * atribución). Pero una línea "Llamado por Fernando" en el historial de Obregón se lee como un operador más
 * de esa tienda. Con el rol a la vista —"Fernando (Administrador)"— no se confunde, y quien revise un pedido
 * sabe que lo tocó alguien de fuera de la tienda.
 *
 * Un empleado conserva su nombre. Y no se repite lo que el nombre ya dice: la cuenta sembrada se llama
 * "Administrador", y "Administrador (Administrador)" no informa nada.
 */
export function nombreDeActor(usuario: { rol: RolUsuario; nombre: string }): string {
  const nombre = (usuario.nombre ?? '').trim();
  // Oct 2026: el gerente también actúa sobre pedidos de su tienda al destrabarlos; su rol a la vista deja claro en
  // la bitácora que lo hizo quien supervisa, no un operador más.
  if (usuario.rol === RolUsuario.GERENTE) {
    if (!nombre) return 'Gerente';
    return /gerente/i.test(nombre) ? nombre : `${nombre} (Gerente)`;
  }
  if (usuario.rol !== RolUsuario.ADMIN) return usuario.nombre;
  if (!nombre) return 'Administrador';
  return /admin/i.test(nombre) ? nombre : `${nombre} (Administrador)`;
}
