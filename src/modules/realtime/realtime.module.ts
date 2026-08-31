import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Módulo de tiempo real.
 *
 * - Socket.IO + @socket.io/redis-adapter (reutiliza ioredis + REDIS_URL).
 * - Auth vía JWT en el handshake (rechaza conexión si token inválido).
 * - Una conexión por cliente; rooms automáticos:
 *     user-{userId}     — canal privado del usuario
 *     tienda-{id}       — para BODEGA/CAJERO/MONITOR/ADMIN de esa tienda
 *     admin:all         — sólo ADMIN, escucha todas las tiendas
 * - El cliente puede unirse explícitamente a `pedido-{id}` para actualizaciones
 *   detalladas (surtido, mensajes, etc.).
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Mismo valor validado que main.ts (app.jwtSecret). Sin fallback.
        secret: config.get<string>('app.jwtSecret'),
        signOptions: { expiresIn: '1h' },
      }),
    }),
  ],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
