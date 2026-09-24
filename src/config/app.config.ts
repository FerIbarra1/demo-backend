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
  // PR7 (kiosko-profesional): secreto HMAC para tokens QR de "avisar
  // llegada". NUNCA compartir con JWT_SECRET — un secreto comprometido
  // debe invalidar solo una familia de tokens. Sin fallback: si falta,
  // los QRs no se firman y la app aborta al arranque.
  kioskoQrSecret: process.env.KIOSKO_QR_SECRET,
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
    // Endpoint custom para proveedores S3-compatibles (R2, MinIO, Spaces).
    // Vacío = AWS.
    endpoint: process.env.AWS_S3_ENDPOINT || '',
    // true para MinIO y la mayoría de self-hosted; false para AWS/R2.
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  },
  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: process.env.SMTP_SECURE === 'true',
    from: process.env.SMTP_FROM || 'no-reply@tienda.local',
    // A dónde van las respuestas del cliente. Los correos dicen "contesta este
    // correo", así que debe apuntar a un buzón real y monitoreado. Vacío = el
    // cliente responde al `from`.
    replyTo: process.env.SMTP_REPLY_TO || '',
  },
  mail: {
    // URL absoluta del logo para el encabezado de los correos.
    //
    // Debe ser alcanzable desde el cliente de correo del destinatario, así que
    // NUNCA puede ser localhost ni una ruta relativa. Antes el fallback era
    // `FRONTEND_URL/Logo.png`, que en dev daba `http://localhost:3001/Logo.png`:
    // el logo salía roto en todos los correos.
    //
    // Orden: logo subido desde el panel ADMIN (tabla configuracion_sitio, que
    // tiene prioridad en ConfiguracionService) → MAIL_LOGO_URL → S3.
    logoUrl:
      process.env.MAIL_LOGO_URL ||
      (process.env.AWS_S3_BUCKET
        ? `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/branding/logo.png`
        : ''),
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3001',
    passwordResetExpiresMin: parseInt(
      process.env.PASSWORD_RESET_EXPIRES_MIN || '60',
      10,
    ),
  },
}));
