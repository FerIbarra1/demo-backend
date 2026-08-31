/**
 * Mapeos de presentación compartidos del dominio de pedidos. Centraliza la
 * lógica que antes se duplicaba en varios services (con casts `any`) para
 * que no diverja.
 */

interface NombreCompleto {
  nombre?: string | null;
  apellido?: string | null;
}

/**
 * Concatena nombre + apellido de un usuario. Devuelve null si ambos están
 * vacíos (para que la UI pueda mostrar "—" en lugar de un string vacío).
 */
export function asignadoANombre(u: NombreCompleto | null | undefined): string | null {
  if (!u) return null;
  const n = `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim();
  return n || null;
}
