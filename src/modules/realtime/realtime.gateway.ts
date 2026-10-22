import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { leerTiendaElegida } from '../../common/tienda-consola';
import { esTokenDeAcceso } from '../auth/token-acceso.util';

/**
 * Gateway de Socket.IO. Namespace por defecto (raíz).
 *
 * - Auth: el cliente envía `auth.token` en el handshake. Se valida como JWT
 *   (mismo JWT_SECRET que el REST). Si falla, la conexión se rechaza.
 * - Rooms automáticos en handleConnection:
 *     user-{userId}                       privado del usuario
 *     tienda-{tiendaId}                   si tiene tienda (no admin sin tienda)
 *     admin:all                           si rol === ADMIN
 *     tesoreria                           si rol === TESORERIA o ADMIN
 * - El ADMIN no tiene tienda: para recibir los eventos de la que está operando manda
 *   `tienda.mirar` ({ tiendaId }) y el server lo une a `tienda-{id}` (UNA a la vez; al cambiar sale de
 *   la anterior). `tienda.dejar-de-mirar` lo saca. PLAN-ADMIN-MULTITIENDA F3.
 * - El cliente puede hacer `socket.emit('joinPedido', pedidoId)` y el server lo
 *   une a `pedido-{id}` (validando que el usuario tenga derecho: dueño, asignado,
 *   o admin). Útil para actualizaciones de un pedido concreto (surtido, mensajes).
 */

interface SocketData {
  userId: number;
  rol: RolUsuario;
  tiendaId?: number;
  nombre: string;
  /** Solo ADMIN: la tienda de cuyo room está mirando AHORA (`tienda.mirar`). Una a la vez. */
  tiendaMirada?: number;
  /** Corta el socket cuando vence el JWT con el que entró (ver `handleConnection`). */
  vencimiento?: ReturnType<typeof setTimeout>;
}

interface JwtPayload {
  sub: number;
  email: string;
  rol: RolUsuario;
  tiendaId?: number;
  /** Segundos desde epoch en que vence el access token. */
  exp?: number;
}

/**
 * Origen CORS del socket. En desarrollo cualquiera; en producción SOLO el del frontend (antes `origin: true` también
 * en producción: cualquier sitio podía abrir un socket con las credenciales del navegador). Se evalúa en cada
 * handshake (el decorador es estático y no puede leer `ConfigService`). Sin `Origin` (clientes que no son navegador)
 * se acepta: CORS es una defensa de navegadores y el handshake exige un JWT válido de todos modos.
 */
function origenPermitido(origen: string | undefined): boolean {
  if (process.env.NODE_ENV !== 'production' || !origen) return true;
  const permitido = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  return !!permitido && origen.replace(/\/+$/, '') === permitido;
}

@Injectable()
@WebSocketGateway({
  cors: { origin: (origen, cb) => cb(null, origenPermitido(origen)), credentials: true },
  // En NestJS el namespace por defecto es '/'. Lo dejamos así.
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

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
      // Mismo criterio que `JwtStrategy`: un refresh token o el del QR del kiosko no abren un socket.
      if (!esTokenDeAcceso(payload)) {
        this.logger.debug(`WS ${client.id}: el token no es de acceso, desconectando`);
        client.disconnect(true);
        return;
      }
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
      // El JWT se valida UNA vez, al conectar: sin esto un socket seguía suscrito a los eventos de su tienda horas
      // después de vencer el token, de desactivar al usuario o de cambiarle el rol. Se corta al vencer; el cliente
      // reconecta solo y su handshake (`auth` como callback) manda el token ya renovado.
      if (typeof payload.exp === 'number') {
        const ms = Math.max(payload.exp * 1000 - Date.now(), 0);
        data.vencimiento = setTimeout(() => client.disconnect(true), ms);
        data.vencimiento.unref?.();
      }

      // Rooms automáticos
      await client.join(`user-${data.userId}`);
      if (data.rol === RolUsuario.ADMIN) {
        await client.join('admin:all');
      } else if (data.tiendaId) {
        await client.join(`tienda-${data.tiendaId}`);
      }
      // Oct 2026: Tesorería (y ADMIN, que supervisa) escucha los pagos por transferencia de
      // todas las tiendas. Va APARTE del bloque de tienda: TESORERIA no tiene `tiendaId`.
      if (data.rol === RolUsuario.TESORERIA || data.rol === RolUsuario.ADMIN) {
        await client.join('tesoreria');
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
  async handleJoinPedido(@MessageBody() pedidoId: number, @ConnectedSocket() client: Socket) {
    const data = client.data as SocketData | undefined;
    // El id llega del cliente: debe ser un entero positivo (un string o un objeto rompía el `findUnique` de Prisma).
    if (!data || !Number.isInteger(pedidoId) || pedidoId <= 0) return;

    if (await this.puedeVerPedido(client, pedidoId)) {
      await client.join(`pedido-${pedidoId}`);
      this.logger.debug(`WS ${client.id}: user=${data.userId} se unió a pedido-${pedidoId}`);
    }
  }

  /**
   * PLAN-ADMIN-MULTITIENDA F3: el ADMIN pide MIRAR la tienda que opera. Es la puerta a los eventos
   * operativos de esa tienda, así que se valida: solo un ADMIN (re-comprobado en la BD, no en el token: un
   * token viejo de alguien degradado no vale), con un id bien formado y de una tienda que exista. Una a la
   * vez: al cambiar sale del room anterior, para no recibir eventos de dos tiendas mezclados. Responde por
   * ack `{ ok, tiendaId }` (el cliente deja de sondear solo cuando lo recibe).
   */
  @SubscribeMessage('tienda.mirar')
  async handleMirarTienda(
    @MessageBody() body: { tiendaId?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: boolean; tiendaId?: number; error?: string }> {
    const data = client.data as SocketData | undefined;
    if (!data || data.rol !== RolUsuario.ADMIN || !(await this.sigueSiendoAdmin(data.userId))) {
      return { ok: false, error: 'Solo un administrador puede mirar una tienda.' };
    }
    const tiendaId = leerTiendaElegida(body?.tiendaId);
    if (!tiendaId) return { ok: false, error: 'Tienda inválida.' };
    if (!(await this.prisma.tienda.count({ where: { id: tiendaId } }))) {
      return { ok: false, error: 'La tienda no existe.' };
    }
    if (data.tiendaMirada === tiendaId) return { ok: true, tiendaId };

    if (data.tiendaMirada) await client.leave(`tienda-${data.tiendaMirada}`);
    await client.join(`tienda-${tiendaId}`);
    data.tiendaMirada = tiendaId;
    this.logger.debug(`WS ${client.id}: admin ${data.userId} mira tienda-${tiendaId}`);
    return { ok: true, tiendaId };
  }

  @SubscribeMessage('tienda.dejar-de-mirar')
  async handleDejarDeMirarTienda(@ConnectedSocket() client: Socket): Promise<{ ok: boolean }> {
    const data = client.data as SocketData | undefined;
    if (data?.tiendaMirada) {
      await client.leave(`tienda-${data.tiendaMirada}`);
      data.tiendaMirada = undefined;
    }
    return { ok: true };
  }

  private async sigueSiendoAdmin(userId: number): Promise<boolean> {
    const u = await this.prisma.usuario.findUnique({
      where: { id: userId },
      select: { rol: true, activo: true, deletedAt: true },
    });
    return !!u && u.rol === RolUsuario.ADMIN && u.activo && u.deletedAt === null;
  }

  /**
   * Reusado por `joinPedido`. Valida que el caller tenga
   * derecho sobre el pedido: dueño, operador de la tienda, o admin global.
   */
  private async puedeVerPedido(client: Socket, pedidoId: number): Promise<boolean> {
    const data = client.data as SocketData | undefined;
    if (!data) return false;

    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: { id: true, usuarioId: true, tiendaId: true },
    });
    if (!pedido) return false;

    const esAdmin = data.rol === RolUsuario.ADMIN;
    if (esAdmin) return true;

    const esDueno = pedido.usuarioId === data.userId;

    // CLIENTE: solo su propio pedido. Antes bastaba con que la tienda
    // coincidiera, y como un CLIENTE también lleva `tiendaId` en el JWT
    // (`jwt.strategy.ts`), cualquier cliente podía unirse al room de un pedido
    // ajeno de su misma tienda y recibir en vivo `mensaje.creado`,
    // `surtido.actualizado` y `pedido.estado` de ese pedido. Es la misma regla
    // que aplica `PedidoAccessService.validar`; el gateway la reimplementó por
    // su cuenta y le quedó más permisiva.
    if (data.rol === RolUsuario.CLIENTE) return esDueno;

    // Empleados (bodega, cajero, mostrador, ventas y sus monitores): el pedido
    // debe ser de su tienda. La tienda sale SOLO del JWT (firmado), nunca de un
    // valor del handshake.
    return esDueno || (data.tiendaId != null && pedido.tiendaId === data.tiendaId);
  }

  handleDisconnect(client: Socket) {
    const data = client.data as SocketData | undefined;
    if (data?.vencimiento) clearTimeout(data.vencimiento);
    this.logger.debug(
      `WS ${client.id} desconectado: user=${data?.userId ?? '-'} rol=${data?.rol ?? '-'}`,
    );
  }
}
