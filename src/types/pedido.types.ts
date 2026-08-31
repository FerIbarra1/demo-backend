import { RolUsuario } from '@prisma/client';

export interface UserContext {
  userId: number;
  nombre: string;
  rol: RolUsuario;
  tiendaId?: number;
}
