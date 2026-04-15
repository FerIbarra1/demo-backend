import { RolUsuario } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        email: string;
        rol: RolUsuario;
        tiendaId?: number;
        nombre: string;
      };
    }
  }
}
