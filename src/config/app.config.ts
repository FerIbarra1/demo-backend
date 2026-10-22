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
  // Cuántos proxies hay DELANTE del backend (nginx en la VPS = 1). Sin esto Express toma como IP del cliente la
  // del proxy: el límite de peticiones por IP (`ThrottlerGuard`) juntaría a TODOS los clientes del negocio en un
  // solo cubo de 100/min, y la IP que guardan la auditoría y los emparejamientos sería siempre la de nginx.
  // 0 en desarrollo (sin proxy); NUNCA más de los que hay: con un número mayor, un cliente falsifica
  // `X-Forwarded-For` para esquivar el límite.
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  // API key del agente externo (Firebird). Sin fallback: si no está definida,
  // ApiKeyGuard rechaza toda petición del agente.
  agentApiKey: process.env.AGENT_API_KEY,
  // Orígenes CORS permitidos en producción. Se derivan de FRONTEND_URL o de
  // CORS_ORIGINS (lista separada por comas). En dev se permite cualquier origen.
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
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
  // F22 (oct 2026): pedidos apartados en el área de entrega que nadie recoge.
  // Horas contadas desde que la bolsa quedó esperando al cliente
  // (`Pedido.esperaClienteDesdeAt`).
  pedidosSinRecoger: {
    // A las N horas se le manda al cliente "¿aún quieres tu pedido?" (una vez).
    recordatorioHoras: parseInt(process.env.PEDIDO_RECORDATORIO_HORAS || '24', 10),
    // A las N horas el pedido aparece como VENCIDO en la consola de mostrador, y el
    // operador puede cancelarlo (el cliente recibe el correo con el motivo).
    // Debe ser mayor que `recordatorioHoras`: el cliente tiene que tener tiempo de
    // contestar entre el aviso y el vencimiento.
    vencidoHoras: parseInt(process.env.PEDIDO_VENCIDO_HORAS || '72', 10),
    // Un aviso de llegada que nadie atendió en N horas caduca solo: el cliente que
    // avisó y se fue no puede quedar en la TV de mañana.
    presenciaCaducaHoras: parseInt(process.env.PRESENCIA_CADUCA_HORAS || '8', 10),
  },
  // Oct 2026: pagos por transferencia (ver PLAN-PAGOS-TRANSFERENCIA.md).
  pagos: {
    // (Oct 2026: ya no hay plazo de vigencia. Las instrucciones no vencen solas: Tesorería las marca
    // vencidas cuando lo decide. Se quitó `PAGO_TRANSFERENCIA_VENCE_HORAS`.)
    // Zona horaria con la que se escriben las fechas de la conciliación y sus cortes del día. Las tiendas
    // están en husos distintos y el modelo no guarda el de cada una, así que se fija una.
    zonaHoraria: process.env.PAGOS_ZONA_HORARIA || 'America/Mexico_City',
    // Cuántas horas puede esperar una transferencia VERIFICADA a que la tienda la registre en VFP
    // antes de marcarse "atrasada" en la cola de Tesorería (es el olvido más probable del flujo).
    alertaSinRegistrarHoras: parseInt(process.env.PAGOS_ALERTA_SIN_REGISTRAR_HORAS || '4', 10),
    comprobantes: {
      // Bucket dedicado para comprobantes. Opcional: sin él se usa el bucket de las imágenes bajo
      // `comprobantes/`, y `ComprobanteStorageService` comprueba que ese prefijo NO sea de lectura
      // pública antes de guardar nada (falla cerrado si lo es).
      bucket: process.env.AWS_S3_COMPROBANTES_BUCKET || '',
      // Tope por archivo. Las apps de banco exportan PDFs de más de 5 MB rara vez.
      maxBytes: parseInt(process.env.COMPROBANTE_MAX_BYTES || String(8 * 1024 * 1024), 10),
    },
  },
  // Oct 2026: impresión DTF (ver PLAN-DTF.md).
  dtf: {
    // Tope por archivo. Un PDF de 57 × 250 cm a 300 DPI pesa decenas o cientos de MB.
    maxBytes: parseInt(process.env.DTF_MAX_BYTES || String(300 * 1024 * 1024), 10),
    // Tiempo y memoria del proceso hijo que mide el archivo (si se pasa, queda "no concluyente").
    preflightTimeoutMs: parseInt(process.env.DTF_PREFLIGHT_TIMEOUT_MS || '90000', 10),
    preflightMemoriaMb: parseInt(process.env.DTF_PREFLIGHT_MEMORIA_MB || '2048', 10),
    // Cuánto vive un borrador (carrito) antes de expirar.
    borradorHoras: parseInt(process.env.DTF_BORRADOR_HORAS || '24', 10),
    // Vigencia del QR de "sube desde tu celular".
    subidaMovilMin: parseInt(process.env.DTF_SUBIDA_MOVIL_MIN || '15', 10),
    // Bucket PRIVADO opcional; sin él, el prefijo `dtf/` del bucket de imágenes (con prueba de privacidad).
    bucket: process.env.AWS_S3_DTF_BUCKET || '',
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
    passwordResetExpiresMin: parseInt(process.env.PASSWORD_RESET_EXPIRES_MIN || '60', 10),
  },
}));
