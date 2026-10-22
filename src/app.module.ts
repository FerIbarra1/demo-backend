import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import appConfig from './config/app.config';
import { PrismaModule } from './prisma/prisma.module';
import { PreciosModule } from './modules/precios/precios.module';
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
import { EstacionesModule } from './modules/estaciones/estaciones.module';
import { SyncModule } from './modules/sync/sync.module';
import { ImagenesModule } from './modules/imagenes/imagenes.module';
import { ConfiguracionModule } from './modules/configuracion/configuracion.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { PagosModule } from './modules/pagos/pagos.module';
import { DtfModule } from './modules/dtf/dtf.module';
import { AdminTorreModule } from './modules/admin-torre/admin-torre.module';
import { DestrabarModule } from './modules/destrabar/destrabar.module';
import { HealthModule } from './modules/health/health.module';
import { ActividadWorkersModule } from './common/actividad-workers';
import { SeriesModule } from './common/folio/series.module';
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
    // N3: la última corrida de cada worker (global; los workers lo piden como @Optional).
    ActividadWorkersModule,
    SeriesModule,
    // Fase 0 (sep 2026): resolución de la lista de precios del cliente.
    // @Global() — la usan catálogo, cliente y propuesta. Va antes de los
    // módulos de dominio que la consumen.
    PreciosModule,
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
    EstacionesModule,
    // Imágenes de productos (panel ADMIN): subida a S3 + gestión.
    ImagenesModule,
    // Configuración editable desde el panel ADMIN (logo de los correos).
    ConfiguracionModule,
    // Gestión de usuarios (panel ADMIN): empleados + clientes.
    UsuariosModule,
    // Oct 2026: pagos por transferencia (cuentas, instrucciones, comprobantes, Tesorería).
    PagosModule,
    DtfModule,
    // N1 (oct 2026): torre de control del ADMIN (una tarjeta por tienda).
    AdminTorreModule,
    DestrabarModule,
    // Salud del servicio (`/api/health`, `/api/health/ready`) para nginx, Docker y el monitor de disponibilidad.
    HealthModule,
    // F11 (ago 2026): gestión de ventanillas físicas del módulo de cajeros.
    // Se importa desde PedidosModule para que CajeroService pueda usar
    // VentanillasService — no se registra aquí para evitar duplicados.
    // F9 (ago 2026): endpoints para el agente de sincronización con Firebird.
    // Va después de PedidosModule porque PedidoPagoHandler reusa AdminService.
    SyncModule,
    // Rate limiting global: 300 req / 60s por RUTA y por usuario con sesión (por IP si no la hay; ver
    // `UserThrottlerGuard`). Antes eran 100 por IP: una tienda entera sale por una IP y sus consolas, tablets y TV
    // hacen polling a las mismas rutas. Los endpoints sensibles (login, registro, kiosko, DTF…) fijan uno más
    // estricto con @Throttle().
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 300,
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
      useClass: UserThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
})
export class AppModule {}
