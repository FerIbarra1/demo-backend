import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import appConfig from './config/app.config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { TiendasModule } from './modules/tiendas/tiendas.module';
import { CatalogoModule } from './modules/catalogo/catalogo.module';
import { PedidosModule } from './modules/pedidos/pedidos.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MailModule } from './modules/mail/mail.module';
import { FavoritosModule } from './modules/favoritos/favoritos.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { KioskoModule } from './modules/kiosko/kiosko.module';
import { MostradorModule } from './modules/mostrador/mostrador.module';
import { SyncModule } from './modules/sync/sync.module';
import { VentanillasModule } from './modules/ventanillas/ventanillas.module';
import { ImagenesModule } from './modules/imagenes/imagenes.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { Reflector } from '@nestjs/core';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    PrismaModule,
    AuthModule,
    TiendasModule,
    CatalogoModule,
    MailModule,
    NotificationsModule,
    PedidosModule,
    FavoritosModule,
    RealtimeModule,
    KioskoModule,
    MostradorModule,
    // Imágenes de productos (panel ADMIN): subida a S3 + gestión.
    ImagenesModule,
    // Gestión de usuarios (panel ADMIN): empleados + clientes.
    UsuariosModule,
    // F11 (ago 2026): gestión de ventanillas físicas del módulo de cajeros.
    // Se importa desde PedidosModule para que CajeroService pueda usar
    // VentanillasService — no se registra aquí para evitar duplicados.
    // F9 (ago 2026): endpoints para el agente de sincronización con Firebird.
    // Va después de PedidosModule porque PedidoPagoHandler reusa AdminService.
    SyncModule,
    // Rate limiting global: 100 req / 60s por IP para endpoints generales.
    // Los endpoints sensibles como /auth/login usan límites más estrictos
    // vía decorador @Throttle() (no aplicado aún en este PR, ver TODO).
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
  ],
  providers: [
    Reflector,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
})
export class AppModule {}