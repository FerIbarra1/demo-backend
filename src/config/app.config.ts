import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || '/api',
  jwtSecret: process.env.JWT_SECRET || 'default-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
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
