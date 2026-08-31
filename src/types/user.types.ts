import { RolUsuario } from '@prisma/client';

export interface JwtPayload {
  sub: number;
  email: string;
  rol: RolUsuario;
  tiendaId?: number;
  /** Identificador único del refresh token (jti). Se persiste en BD para rotación/revocación. */
  jti?: string;
}

export interface KioskTokenPayload {
  sub: number;
  kind: 'kiosk';
  tiendaId: number;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  /** Id del refresh token persistido en BD (para revocación explícita). */
  refreshTokenId: number;
  expiresIn: number;
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
