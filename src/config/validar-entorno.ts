/**
 * Validación del entorno al ARRANCAR. Una sola función pura que dice TODO lo que está mal de una vez (no una variable
 * por arranque fallido) y que `main.ts` convierte en un error que aborta el proceso.
 *
 * Por qué existe: la limpieza de envs (oct 2026) dejó un conjunto mínimo, y lo que falta o es de ejemplo es justo lo
 * que más caro sale descubrir en producción — un `JWT_SECRET="secret-key"` permite forjar tokens de ADMIN, un
 * `FRONTEND_URL` sin https deja la cookie de sesión sin `Secure`, y sin S3 las imágenes y los comprobantes van a disco
 * local y se pierden en cada despliegue.
 *
 * Siempre (también en desarrollo): JWT_SECRET y KIOSKO_QR_SECRET (≥32 caracteres y distintos entre sí). En
 * producción además: base de datos, agente, frontend, correo y S3.
 */

const MARCAS_DE_EJEMPLO = /cambiar|changeme|secret-key|dev-agent-key|ejemplo|example/i;

function secretoDebil(valor: string | undefined, minimo = 32): string | null {
  if (!valor) return 'no está definido';
  if (valor.length < minimo) return `tiene ${valor.length} caracteres (mínimo ${minimo})`;
  if (MARCAS_DE_EJEMPLO.test(valor)) return 'es un valor de ejemplo';
  return null;
}

export function validarEntorno(env: NodeJS.ProcessEnv, esProduccion: boolean): string[] {
  const problemas: string[] = [];
  const falta = (nombre: string, detalle: string) => problemas.push(`${nombre}: ${detalle}`);

  // ── Siempre ────────────────────────────────────────────────────────────────────────────────────────────────────
  if (!env.JWT_SECRET)
    falta('JWT_SECRET', 'es obligatorio (genera uno con: openssl rand -base64 48)');
  if (!env.KIOSKO_QR_SECRET) {
    falta('KIOSKO_QR_SECRET', 'es obligatorio (genera uno con: openssl rand -base64 48)');
  } else if (env.KIOSKO_QR_SECRET.length < 32) {
    falta('KIOSKO_QR_SECRET', `tiene ${env.KIOSKO_QR_SECRET.length} caracteres (mínimo 32)`);
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.KIOSKO_QR_SECRET) {
    falta(
      'KIOSKO_QR_SECRET',
      'no puede ser igual a JWT_SECRET: si uno se compromete, el otro no debe caer',
    );
  }

  if (!esProduccion) return problemas;

  // ── Producción ─────────────────────────────────────────────────────────────────────────────────────────────────
  const jwt = secretoDebil(env.JWT_SECRET);
  if (jwt && env.JWT_SECRET)
    falta('JWT_SECRET', `${jwt}: con él se pueden forjar tokens de cualquier rol`);
  const qr = env.KIOSKO_QR_SECRET ? secretoDebil(env.KIOSKO_QR_SECRET) : null;
  if (qr && env.KIOSKO_QR_SECRET && env.KIOSKO_QR_SECRET.length >= 32)
    falta('KIOSKO_QR_SECRET', qr);
  const agente = secretoDebil(env.AGENT_API_KEY);
  if (agente)
    falta(
      'AGENT_API_KEY',
      `${agente}: autentica al agente del Sistema Comercial (genera uno con: openssl rand -hex 32)`,
    );

  if (!env.DATABASE_URL) falta('DATABASE_URL', 'es obligatoria');

  if (!env.FRONTEND_URL) {
    falta(
      'FRONTEND_URL',
      'es obligatoria: es el único origen CORS permitido y la base de los enlaces de los correos',
    );
  } else if (!/^https:\/\//i.test(env.FRONTEND_URL)) {
    falta(
      'FRONTEND_URL',
      `debe ser https:// (es "${env.FRONTEND_URL}"): la cookie de sesión va con Secure`,
    );
  } else {
    // Es el origen CORS y se compara TAL CUAL con el `Origin` del navegador: con una ruta («https://x.com/app») todas las
    // llamadas del navegador quedarían bloqueadas. Una barra final sí se tolera (`app.config` la quita).
    try {
      const u = new URL(env.FRONTEND_URL.trim());
      if (u.pathname.replace(/\/+$/, '') !== '' || u.search || u.hash) {
        falta(
          'FRONTEND_URL',
          `debe ser solo el origen (https://dominio), sin ruta ni parámetros (es "${env.FRONTEND_URL}")`,
        );
      }
    } catch {
      falta('FRONTEND_URL', `no es una URL válida ("${env.FRONTEND_URL}")`);
    }
  }

  if (!env.SMTP_HOST || /^(localhost|127\.0\.0\.1)$/i.test(env.SMTP_HOST)) {
    falta(
      'SMTP_HOST',
      'apunta a localhost: los correos transaccionales (recuperar contraseña, pedidos) no saldrían',
    );
  }
  for (const nombre of ['SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const) {
    if (!env[nombre]) falta(nombre, 'es obligatoria');
  }
  // Sin puerto el backend usa el de MailHog (1025) y los correos no salen, sin ningún error de arranque.
  if (!env.SMTP_PORT) {
    falta('SMTP_PORT', 'es obligatoria (587 con STARTTLS, 465 con TLS implícito)');
  } else if (!/^\d{1,5}$/.test(env.SMTP_PORT.trim())) {
    falta('SMTP_PORT', `debe ser un número de puerto (es "${env.SMTP_PORT}")`);
  }

  if (env.TRUST_PROXY_HOPS !== undefined && env.TRUST_PROXY_HOPS.trim() !== '') {
    if (!/^\d+$/.test(env.TRUST_PROXY_HOPS.trim()))
      falta('TRUST_PROXY_HOPS', `debe ser un entero ≥ 0 (es "${env.TRUST_PROXY_HOPS}")`);
  }

  // Sin S3, las imágenes y los comprobantes bancarios caen a disco local: se pierden en cada despliegue.
  for (const nombre of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET',
    'AWS_REGION',
  ] as const) {
    if (!env[nombre])
      falta(
        nombre,
        'es obligatoria en producción (sin S3 las imágenes y comprobantes se guardan en disco local y se pierden al redesplegar)',
      );
  }

  return problemas;
}

/** El mensaje de error de arranque: todo junto, accionable. */
export function mensajeDeEntornoInvalido(problemas: string[]): string {
  return `Entorno inválido (${problemas.length}):\n${problemas.map((p) => `  - ${p}`).join('\n')}`;
}
