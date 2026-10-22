import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { StorageService } from './modules/imagenes/storage.service';
import { mensajeDeEntornoInvalido, validarEntorno } from './config/validar-entorno';

async function bootstrap() {
  // Antes de levantar nada: si el entorno está mal, se dice TODO lo que falta de una vez y se aborta. En producción
  // exige el conjunto mínimo completo (secretos reales, https, correo, S3); en desarrollo solo los dos secretos.
  const esProduccion = process.env.NODE_ENV === 'production';
  const problemas = validarEntorno(process.env, esProduccion);
  if (problemas.length) throw new Error(mensajeDeEntornoInvalido(problemas));

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Apagado ordenado: sin esto, un SIGTERM (docker stop, PM2 reload, un redespliegue) mata el proceso sin ejecutar los
  // `onModuleDestroy` —los barridos programados, la conexión a la BD, los sockets—. Con esto sí corren antes de salir.
  // Ojo: NO es un drenado. Nest 11 (`close()`) ejecuta los `onModuleDestroy` (incluido el `$disconnect` de Prisma) ANTES de cerrar
  // el servidor HTTP, así que una petición a medias en el instante exacto del apagado puede fallar.
  app.enableShutdownHooks();

  // Detrás de nginx (VPS), la IP real del cliente viene en `X-Forwarded-For`. Ver `trustProxyHops` en app.config.
  const trustProxyHops = configService.get<number>('app.trustProxyHops') ?? 0;
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  } else if (process.env.NODE_ENV === 'production') {
    // No se aborta (puede haber un despliegue sin proxy), pero se grita: con nginx delante y esto en 0, todos los
    // clientes comparten un límite de peticiones y las tablets de las tiendas topan con 429 en horas pico.
    new Logger('Bootstrap').warn(
      'TRUST_PROXY_HOPS=0 en producción: si hay un proxy (nginx) delante, el límite por IP verá una sola IP. ' +
        'Pon TRUST_PROXY_HOPS=1 detrás de nginx.',
    );
  }

  // Configuración de seguridad.
  // El fallback local de imágenes (/files/) se sirve desde OTRO origen (el
  // frontend corre en otro puerto), así que la política por defecto de helmet
  // (Cross-Origin-Resource-Policy: same-origin + CSP img-src 'self') lo bloquea
  // y las imágenes subidas en dev nunca se ven. Se relaja solo para /files/:
  // son assets estáticos públicos, no respuestas de API.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        },
      },
    }),
  );
  app.use(compression());
  // Parsear cookies (necesario para leer el refresh token httpOnly).
  app.use(cookieParser());

  // CORS. En producción se usan los orígenes de config (app.corsOrigins = FRONTEND_URL, sin barra final).
  // En dev se permite cualquier origen.
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? corsOrigins : true,
    credentials: true,
    // Sin esto el navegador (otro origen) NO deja leer `Content-Disposition`, y una descarga
    // pierde el nombre de archivo que el servidor le puso (p. ej. el CSV de conciliación).
    exposedHeaders: ['Content-Disposition'],
  });

  // Prefijo global
  const apiPrefix = configService.get<string>('app.apiPrefix') || '/api';
  app.setGlobalPrefix(apiPrefix);

  // Archivos subidos dinámicamente (uploads de productos / imágenes que
  // sincronice el agente externo) bajo /files/...
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/files/' });

  // Pipes de validación
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger Documentation — solo en desarrollo. En producción no se expone
  // para no filtrar el contrato de la API (endpoints, DTOs, esquemas).
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Tienda de Camisetas API')
      .setDescription('API para gestión de pedidos de camisetas')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  // Puerto
  const port = configService.get<number>('app.port') || 3000;

  // Comprobar el storage al arrancar: un bucket mal configurado debe verse en
  // los logs del deploy, no en el primer intento de subida del admin.
  await app.get(StorageService).verificarConexion();

  await app.listen(port);

  console.log(`\n🚀 Servidor iniciado en: http://localhost:${port}`);
  console.log(`📚 Documentación Swagger: http://localhost:${port}/api/docs`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}\n`);
}

bootstrap();
