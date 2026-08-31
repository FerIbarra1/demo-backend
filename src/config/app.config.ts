import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || '/api',
  // Sin fallback: si JWT_SECRET falta, main.ts lanza y aborta el arranque.
  // Un fallback 'default-secret' anularía esa guardia y permitiría firmar
  // tokens con un secreto público conocido (forja de tokens de cualquier rol).
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  // API key del agente externo (Firebird). Sin fallback: si no está definida,
  // ApiKeyGuard rechaza toda petición del agente.
  agentApiKey: process.env.AGENT_API_KEY,
  // Orígenes CORS permitidos en producción. Se derivan de FRONTEND_URL o de
  // CORS_ORIGINS (lista separada por comas). En dev se permite cualquier origen.
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL]
      : [],
  // Almacenamiento de imágenes de productos en AWS S3 (panel ADMIN).
  // Si falta accessKeyId/secretAccessKey, StorageService cae a disco local
  // (uploads/ → /files/) para que el dev funcione sin credenciales.
  s3: {
    bucket: process.env.AWS_S3_BUCKET || '',
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    // URL pública base (puede ser el endpoint del bucket o un CDN).
    publicUrlBase: process.env.AWS_S3_PUBLIC_URL || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: process.env.SMTP_SECURE === 'true',
    from: process.env.SMTP_FROM || 'no-reply@tienda.local',
  },
  mail: {
    // URL absoluta del logo, resuelta contra el frontend (que es donde vive
    // el asset). En dev: http://localhost:3001/Logo.png. En prod: el dominio
    // público del front.
    logoUrl: process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/Logo.png`
      : 'http://localhost:3001/Logo.png',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
    passwordResetExpiresMin: parseInt(
      process.env.PASSWORD_RESET_EXPIRES_MIN || '60',
      10,
    ),
  },
}));
