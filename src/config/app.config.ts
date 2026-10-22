import { registerAs } from '@nestjs/config';

/**
 * Configuración de la app. Regla (oct 2026): una variable de entorno existe solo si cambia ENTRE entornos
 * (secretos, URLs, credenciales). Lo que es una regla del negocio o un acuerdo entre piezas del sistema es una
 * CONSTANTE de este archivo: ponerlo en el `.env` solo da modo de desincronizarlo en silencio (la vida del
 * access token está también en el frontend; la del refresh token, en la cookie y en la ventana de sesión).
 *
 * Variables que se leen (obligatorias en producción marcadas con *):
 *   DATABASE_URL* (+DIRECT_DATABASE_URL solo con pooler tipo Neon) · JWT_SECRET* · KIOSKO_QR_SECRET* · AGENT_API_KEY* ·
 *   FRONTEND_URL* · SMTP_HOST/PORT/USER/PASS/FROM* · AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION/S3_BUCKET*
 * Opcionales: PORT · SMTP_REPLY_TO · AWS_S3_PRIVATE_BUCKET · PAGOS_ZONA_HORARIA · TRUST_PROXY_HOPS
 */

/** Tope por archivo DTF. Un PDF de 57 × 250 cm a 300 DPI pesa decenas o cientos de MB. Lo usan Multer y el servicio. */
export const DTF_MAX_BYTES = 300 * 1024 * 1024;

/** Región por defecto: la del bucket de producción. Un solo valor (antes había `us-east-1` aquí y `us-west-2` en el logo). */
const REGION_S3_POR_DEFECTO = 'us-west-2';

/**
 * Clave de S3 de las imágenes públicas del sitio. El logo de los correos lo sube el admin desde el panel
 * (`configuracion_sitio`) y, si no hay, se toma de aquí.
 */
const LOGO_KEY = 'branding/logo.png';

function s3() {
  const bucket = process.env.AWS_S3_BUCKET || '';
  const region = process.env.AWS_REGION || REGION_S3_POR_DEFECTO;
  return {
    // Bucket PÚBLICO (lectura de objetos): fotos de producto y logo. Las URLs públicas se DERIVAN de bucket + región.
    bucket,
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    // Bucket PRIVADO opcional (sin lectura pública) para lo sensible: comprobantes de transferencia (datos bancarios) y
    // archivos DTF. UNA sola variable para los dos (antes AWS_S3_COMPROBANTES_BUCKET y AWS_S3_DTF_BUCKET). Sin ella se
    // usan los prefijos `comprobantes/` y `dtf/` del bucket público, previa PRUEBA de que no sean legibles sin
    // credenciales (falla cerrado si lo son).
    privateBucket: process.env.AWS_S3_PRIVATE_BUCKET || '',
  };
}

/**
 * Cuántos proxies hay DELANTE del backend. Vacía o inválida → el valor por defecto (antes `??` solo cubría «no
 * definida»: `TRUST_PROXY_HOPS=` dejaba `parseInt('')` = NaN y quedaba en 0 sin avisar). `validarEntorno` rechaza en
 * producción un valor que no sea un entero, así que aquí el fallback es solo una red de seguridad.
 */
function proxiesDelante(esProduccion: boolean): number {
  const porDefecto = esProduccion ? 1 : 0;
  const crudo = process.env.TRUST_PROXY_HOPS;
  if (crudo === undefined || crudo.trim() === '') return porDefecto;
  const n = Number(crudo.trim());
  return Number.isInteger(n) && n >= 0 ? n : porDefecto;
}

export default registerAs('app', () => {
  const s3Config = s3();
  const esProduccion = process.env.NODE_ENV === 'production';
  // Sin barras finales: es el origen CORS (se compara tal cual con el `Origin` del navegador, que nunca lleva `/`) y la
  // base de los enlaces de los correos.
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3001')
    .trim()
    .replace(/\/+$/, '');
  const smtpPort = parseInt(process.env.SMTP_PORT || '1025', 10);

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    // El prefijo es un acuerdo con el frontend (`NEXT_PUBLIC_API_URL` termina en `/api`) y con nginx: no varía.
    apiPrefix: '/api',
    // Sin fallback: si JWT_SECRET falta, main.ts lanza y aborta el arranque. Un fallback 'default-secret' anularía esa
    // guardia y permitiría firmar tokens con un secreto público conocido (forja de tokens de cualquier rol).
    jwtSecret: process.env.JWT_SECRET,
    // Vida del access token y del refresh token: CONSTANTES. El frontend asume 1 h (programa el refresh) y la
    // ventana de la cookie de sesión (`VENTANA_SESION_S`) y la cookie del refresh asumen 7 d: cambiar una sola
    // desincroniza tres sitios.
    jwtExpiresIn: '1h',
    jwtRefreshExpiresIn: '7d',
    // Vida del QR de "iniciar sesión en el kiosko".
    kioskTokenExpiresIn: '5m',
    // Secreto HMAC de los QR de "avisar llegada". NUNCA el mismo que JWT_SECRET: un secreto comprometido debe invalidar
    // solo una familia de tokens. Sin fallback: si falta, la app aborta al arrancar.
    kioskoQrSecret: process.env.KIOSKO_QR_SECRET,
    // Cuántos proxies hay DELANTE del backend. En producción SIEMPRE hay uno (nginx / el balanceador de la plataforma,
    // que además termina el TLS), así que por defecto es 1; en desarrollo, 0. Sin esto Express toma como IP del cliente
    // la del proxy y el límite de peticiones juntaría a todos los clientes en un solo cubo. NUNCA más de los que hay: con
    // un número mayor un cliente falsifica `X-Forwarded-For` para esquivar el límite. `TRUST_PROXY_HOPS` lo fuerza.
    trustProxyHops: proxiesDelante(esProduccion),
    // API key del agente externo (Firebird). Sin fallback: sin ella, ApiKeyGuard rechaza toda petición del agente.
    agentApiKey: process.env.AGENT_API_KEY,
    // Origen CORS: el del frontend. (Antes `CORS_ORIGINS` era una segunda lista que había que mantener igual.)
    corsOrigins: [frontendUrl],
    s3: s3Config,
    // F22 (oct 2026): pedidos apartados en el área de entrega que nadie recoge. Horas contadas desde que la bolsa quedó
    // esperando al cliente (`Pedido.esperaClienteDesdeAt`).
    pedidosSinRecoger: {
      // A las N horas se le manda al cliente "¿aún quieres tu pedido?" (una vez).
      recordatorioHoras: 24,
      // A las N horas el pedido aparece como VENCIDO en la consola de mostrador, y el operador puede cancelarlo (el
      // cliente recibe el correo con el motivo). Debe ser mayor que `recordatorioHoras`: el cliente necesita tiempo
      // de contestar entre el aviso y el vencimiento.
      vencidoHoras: 72,
      // Un aviso de llegada que nadie atendió en N horas caduca solo: el cliente que avisó y se fue no puede quedar en
      // la TV de mañana.
      presenciaCaducaHoras: 8,
    },
    // Oct 2026: pagos por transferencia (ver PLAN-PAGOS-TRANSFERENCIA.md).
    pagos: {
      // Zona horaria del "día del negocio" de la conciliación y su CSV. Las tiendas están en husos distintos (Mexicali y
      // la frontera no coinciden con la hora del centro) y el modelo no guarda el de cada una: se fija una por entorno.
      zonaHoraria: process.env.PAGOS_ZONA_HORARIA || 'America/Mexico_City',
      // Cuántas horas puede esperar una transferencia VERIFICADA a que la tienda la registre en VFP antes de marcarse
      // "atrasada" en la cola de Tesorería (es el olvido más probable del flujo).
      alertaSinRegistrarHoras: 4,
      comprobantes: {
        bucket: s3Config.privateBucket,
        // Tope por archivo. Las apps de banco exportan PDFs de más de 5 MB rara vez.
        maxBytes: 8 * 1024 * 1024,
      },
    },
    // Oct 2026: impresión DTF (ver PLAN-DTF.md).
    dtf: {
      maxBytes: DTF_MAX_BYTES,
      // Tiempo y memoria del proceso hijo que mide el archivo (si se pasa, queda "no concluyente").
      preflightTimeoutMs: 90_000,
      preflightMemoriaMb: 2048,
      // Cuánto vive un borrador (carrito) antes de expirar.
      borradorHoras: 24,
      // Vigencia del QR de "sube desde tu celular".
      subidaMovilMin: 15,
      bucket: s3Config.privateBucket,
    },
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: smtpPort,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      // TLS implícito solo en el 465; en el 587 (y MailHog en el 1025) se negocia con STARTTLS. Antes era una variable
      // aparte que siempre había que mantener coherente con el puerto.
      secure: smtpPort === 465,
      from: process.env.SMTP_FROM || 'no-reply@tienda.local',
      // A dónde van las respuestas del cliente. Los correos dicen "contesta este correo": debe apuntar a un buzón real
      // y monitoreado. Vacío = el cliente responde al `from`.
      replyTo: process.env.SMTP_REPLY_TO || '',
    },
    mail: {
      // URL absoluta del logo del encabezado de los correos. Debe ser alcanzable desde el cliente de correo del
      // destinatario, así que NUNCA localhost ni ruta relativa (antes el fallback era `FRONTEND_URL/Logo.png` y en dev
      // el logo salía roto en todos los correos). Orden: el logo que sube el ADMIN desde el panel
      // (`configuracion_sitio`, que tiene prioridad en ConfiguracionService) → el de S3, derivado de bucket + región.
      logoUrl: s3Config.bucket
        ? `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${LOGO_KEY}`
        : '',
      frontendUrl,
      passwordResetExpiresMin: 60,
    },
  };
});
