import { RolUsuario } from '@prisma/client';

export interface JwtPayload {
  sub: number;
  email: string;
  rol: RolUsuario;
  tiendaId?: number;
}

export interface KioskTokenPayload {
  sub: number;
  kind: 'kiosk';
  tiendaId: number;
}

export interface AuthenticatedUser {
  userId: number;
  email: string;
  rol: RolUsuario;
  tiendaId?: number;
  nombre: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResponse extends TokenResponse {
  user: {
    id: number;
    email: string;
    nombre: string;
    apellido?: string;
    rol: RolUsuario;
    tiendaId?: number;
    telefono?: string;
  };
}
