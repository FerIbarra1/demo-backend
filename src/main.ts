import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  const jwtSecret = configService.get<string>('app.jwtSecret');
  if (!jwtSecret) {
    throw new Error('JWT_SECRET es obligatorio y debe ser un valor seguro en producción');
  }
  // Fase 3: enforce de fortaleza del secreto en producción. Un JWT_SECRET
  // corto (ej. "secret-key") permite a un atacante forjar tokens de cualquier
  // rol (ADMIN). En dev se permite débil para no bloquear el arranque local;
  // en producción fallamos el startup ante un secreto inseguro.
  if (process.env.NODE_ENV === 'production' && jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET debe tener al menos 32 caracteres en producción. Genera uno con: openssl rand -base64 48',
    );
  }

  // Configuración de seguridad
  app.use(helmet());
  app.use(compression());
  // Parsear cookies (necesario para leer el refresh token httpOnly).
  app.use(cookieParser());

  // CORS. En producción se usan los orígenes de config (app.corsOrigins,
  // derivados de FRONTEND_URL o CORS_ORIGINS). En dev se permite cualquier origen.
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: process.env.NODE_ENV === 'production' ? corsOrigins : true,
    credentials: true,
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

  // Swagger Documentation — sólo en desarrollo. En producción no se expone
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

  await app.listen(port);

  console.log(`\n🚀 Servidor iniciado en: http://localhost:${port}`);
  console.log(`📚 Documentación Swagger: http://localhost:${port}/api/docs`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}\n`);
}

bootstrap();
