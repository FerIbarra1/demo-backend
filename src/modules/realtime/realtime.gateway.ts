import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { RolUsuario } from '@prisma/client';

/**
 * Gateway de Socket.IO. Namespace por defecto (raíz).
 *
 * - Auth: el cliente envía `auth.token` en el handshake. Se valida como JWT
 *   (mismo JWT_SECRET que el REST). Si falla, la conexión se rechaza.
 * - Rooms automáticos en handleConnection:
 *     user-{userId}                       privado del usuario
 *     tienda-{tiendaId}                   si tiene tienda (no admin sin tienda)
 *     admin:all                           si rol === ADMIN
 * - El cliente puede hacer `socket.emit('joinPedido', pedidoId)` y el server lo
 *   une a `pedido-{id}` (validando que el usuario tenga derecho: dueño, asignado,
 *   o admin). Útil para actualizaciones de un pedido concreto (surtido, mensajes).
 */

interface SocketData {
  userId: number;
  rol: RolUsuario;
  tiendaId?: number;
  nombre: string;
}

interface JwtPayload {
  sub: number;
  email: string;
  rol: RolUsuario;
  tiendaId?: number;
}

@Injectable()
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  // En NestJS el namespace por defecto es '/'. Lo dejamos así.
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Inicializa el adapter de Redis para que múltiples instancias del backend
   * compartan rooms. Si REDIS_URL no está definida o falla la conexión, se
   * degrada a adapter en memoria (single-instance) y se loguea un warning.
   */
  async afterInit(server: Server) {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (redisUrl) {
      try {
        this.pubClient = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
        this.subClient = this.pubClient.duplicate();
        await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
        server.adapter(createAdapter(this.pubClient, this.subClient));
        this.logger.log('Realtime: Redis adapter conectado');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Realtime: no se pudo conectar a Redis (${msg}). Se usa adapter en memoria (single-instance).`,
        );
      }
    } else {
      this.logger.warn('Realtime: REDIS_URL no configurado. Adapter en memoria.');
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.headers['authorization'] as string | undefined)?.replace(
          /^Bearer\s+/i,
          '',
        );
      if (!token) {
        this.logger.debug(`WS ${client.id}: sin token, desconectando`);
        client.disconnect(true);
        return;
      }
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const data: SocketData = {
        userId: payload.sub,
        rol: payload.rol,
        nombre: (client.handshake.auth?.nombre as string) ?? '',
      };
      // Tienda: priorizar el del JWT (autoritativo), fallback al handshake.auth.
      // Cualquier rol con tienda (BODEGA, CAJERO, BODEGA_MONITOR, CAJERO_MONITOR,
      // CLIENTE con tienda) se une al room tienda-{id} para recibir pedido.creado.
      const tiendaIdFromJwt = (payload as JwtPayload & { tiendaId?: number }).tiendaId;
      const tiendaIdFromHandshake = client.handshake.auth?.tiendaId as number | undefined;
      const tiendaId = tiendaIdFromJwt ?? tiendaIdFromHandshake;
      if (tiendaId) data.tiendaId = tiendaId;
      client.data = data;

      // Rooms automáticos
      await client.join(`user-${data.userId}`);
      if (data.rol === RolUsuario.ADMIN) {
        await client.join('admin:all');
      } else if (data.tiendaId) {
        await client.join(`tienda-${data.tiendaId}`);
      }
      this.logger.debug(
        `WS ${client.id} conectado: user=${data.userId} rol=${data.rol} tienda=${data.tiendaId ?? '-'}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`WS ${client.id}: auth fallida (${msg})`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const data = client.data as SocketData | undefined;
    this.logger.debug(
      `WS ${client.id} desconectado: user=${data?.userId ?? '-'} rol=${data?.rol ?? '-'}`,
    );
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}
