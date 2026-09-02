import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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
    private readonly prisma: PrismaService,
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
        // Cerrar cualquier cliente Redis que haya quedado conectado a medias
        // (p.ej. pubClient conectado pero subClient/adapter falló) para no
        // dejar conexiones huérfanas.
        await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
        this.pubClient = undefined;
        this.subClient = undefined;
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
      // Tienda: SOLO la del JWT (autoritativa, firmada). No se confía en
      // handshake.auth.tiendaId: un cliente podría unirse al room de otra
      // tienda y recibir eventos operativos (pedido.llamado, ventanilla.*).
      const tiendaId = (payload as JwtPayload & { tiendaId?: number }).tiendaId;
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

  /**
   * Une al cliente al room `pedido-{id}` para recibir eventos de ese pedido
   * (mensaje.creado, surtido.actualizado, pedido.estado). Valida que el
   * usuario tenga derecho: dueño del pedido, bodeguero de la tienda, o admin.
   *
   * F12: sin esto, el bodeguero NO recibe los mensajes del cliente en tiempo
   * real (el backend emite a `pedido-{id}`, pero nadie se unía al room).
   */
  @SubscribeMessage('joinPedido')
  async handleJoinPedido(
    @MessageBody() pedidoId: number,
    @ConnectedSocket() client: Socket,
  ) {
    const data = client.data as SocketData | undefined;
    if (!data || !pedidoId) return;

    try {
      const pedido = await this.prisma.pedido.findUnique({
        where: { id: pedidoId },
        select: { id: true, usuarioId: true, tiendaId: true },
      });
      if (!pedido) return;

      const esAdmin = data.rol === RolUsuario.ADMIN;
      const esDueno = pedido.usuarioId === data.userId;
      const esDeSuTienda = data.tiendaId != null && pedido.tiendaId === data.tiendaId;

      if (esAdmin || esDueno || esDeSuTienda) {
        await client.join(`pedido-${pedidoId}`);
        this.logger.debug(
          `WS ${client.id}: user=${data.userId} se unió a pedido-${pedidoId}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`WS joinPedido ${pedidoId}: error (${msg})`);
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
