import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Configuración de seguridad
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: process.env.NODE_ENV === 'production'
      ? ['https://demo-frontend-git-main-feribarra1s-projects.vercel.app']
      : true,
    credentials: true,
  });

  // Prefijo global
  const apiPrefix = configService.get('API_PREFIX') || '/api/v1';
  app.setGlobalPrefix(apiPrefix);

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

  // Swagger Documentation
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

  // Puerto
  const port = configService.get('PORT') || 3000;

  await app.listen(port);

  console.log(`\n🚀 Servidor iniciado en: http://localhost:${port}`);
  console.log(`📚 Documentación Swagger: http://localhost:${port}/api/docs`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}\n`);
}

bootstrap();
