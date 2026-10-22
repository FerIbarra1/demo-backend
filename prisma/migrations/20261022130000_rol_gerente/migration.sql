-- Oct 2026: rol GERENTE (gerente de UNA tienda). Supervisa su tienda: torre de control, salud y búsqueda
-- de pedidos. Aditiva: solo agrega un valor al enum; ningún usuario existente cambia.
--
-- Un valor nuevo de enum no se puede usar en la misma transacción que lo crea, así que esta migración NO
-- inserta usuarios: el seed crea los gerentes de demostración.

-- AlterEnum
ALTER TYPE "RolUsuario" ADD VALUE 'GERENTE';
