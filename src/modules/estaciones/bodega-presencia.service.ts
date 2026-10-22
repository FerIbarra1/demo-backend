import { Injectable, Logger } from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { pausarReloj } from '../pedidos/core/atencion.util';
import { INACTIVIDAD_ESTACION_MS } from '../pedidos/core/estacion.util';
import { ESTADOS_OCUPAN_SLOT_BODEGA } from '../pedidos/core/pedido-limits';

/**
 * Oct 2026: la presencia de un bodeguero en la TV de bodega.
 *
 * Antes la TV daba por "activo" a quien hubiera entrado en las últimas **12 horas**: cerrar sesión
 * no lo quitaba, y entrar no avisaba a la pantalla. El encargado veía fichas de gente que ya se
 * había ido a casa y no veía a quien acababa de llegar. Ahora la presencia es un ESTADO que cambia
 * con la persona:
 *
 *  - **Entrar** (`entro`) lo pone en línea y la TV lo recibe en el momento.
 *  - **Salir** (`salio`) lo quita y le regresa a la cola lo que traía en las manos, igual que soltar
 *    una ventanilla o un mostrador. Sin esto sus pedidos quedaban asignados a alguien que ya no está.
 *  - **El latido** (cada 5 min, desde la tablet) lo mantiene en línea. Es la red de seguridad de
 *    quien cierra la pestaña o pierde la red sin cerrar sesión: tras 15 min sin latido, el barrido
 *    (`salirInactivos`) lo saca igual que si hubiera salido.
 *
 * "En línea" = `ultimoHeartbeat` reciente. Cerrar sesión lo deja en `null`, y `lastLogin` ya no
 * cuenta para la TV: es el historial de cuándo entró por última vez, no de si sigue aquí.
 */
@Injectable()
export class BodegaPresenciaService {
  private readonly logger = new Logger(BodegaPresenciaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Inició sesión: queda en línea y la TV lo recibe. */
  async entro(usuarioId: number, tiendaId: number | null | undefined) {
    await this.prisma.usuario.update({
      where: { id: usuarioId },
      data: { ultimoHeartbeat: new Date() },
      select: { id: true },
    });
    this.avisar(tiendaId, 'bodeguero.entro', usuarioId);
  }

  /**
   * Latido de un bodeguero. Si ya estaba en línea solo renueva la marca; si NO (el barrido lo sacó
   * por una pausa de red larga) lo vuelve a poner en línea y avisa a la TV.
   *
   * Revivir exige una sesión abierta: un latido rezagado que llega DESPUÉS de cerrar sesión no
   * puede volver a poner en la TV a quien ya se fue. Cerrar sesión revoca sus refresh tokens, y
   * ahí se ve.
   */
  async latido(usuarioId: number, ahora: Date = new Date()) {
    const u = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { tiendaId: true, ultimoHeartbeat: true },
    });
    if (!u) return;

    const estabaEnLinea = enLinea(u.ultimoHeartbeat, ahora);
    if (!estabaEnLinea) {
      const sesiones = await this.prisma.refreshToken.count({
        where: { usuarioId, revokedAt: null, expiresAt: { gt: ahora } },
      });
      if (sesiones === 0) return;
    }

    await this.prisma.usuario.update({
      where: { id: usuarioId },
      data: { ultimoHeartbeat: ahora },
      select: { id: true },
    });
    if (!estabaEnLinea) this.avisar(u.tiendaId, 'bodeguero.entro', usuarioId);
  }

  /**
   * Salió (cerró sesión o lleva 15 min sin latido): sale de la TV y sus pedidos regresan a la cola.
   *
   * Los pedidos vuelven SIN asignar y conservando su lugar (`fechaPedido` no se toca), con el reloj
   * de atención pausado como en `BodegaService.liberarPedido`: el tiempo que ya trabajó queda
   * acumulado y no se le cobra al siguiente. Idempotente: sin latido ni pedidos no hace nada.
   */
  async salio(
    usuarioId: number,
    opts: { soloPedidos?: boolean } = {},
  ): Promise<{ pedidosRegresados: number }> {
    const u = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { rol: true, nombre: true, tiendaId: true, ultimoHeartbeat: true },
    });
    // F3.5 ("cubrir puesto"): el ADMIN también puede traer pedidos en las manos, y los devuelve igual que un
    // bodeguero: al cerrar sesión, por inactividad o al cambiar de tienda. `soloPedidos` los devuelve SIN
    // sacarlo de línea (cambiar de tienda no es irse).
    if (!u || (u.rol !== RolUsuario.BODEGA && u.rol !== RolUsuario.ADMIN))
      return { pedidosRegresados: 0 };

    const ahora = new Date();
    const regresados = await this.prisma.$transaction(async (tx) => {
      if (!opts.soloPedidos) {
        await tx.usuario.update({
          where: { id: usuarioId },
          data: { ultimoHeartbeat: null },
          select: { id: true },
        });
      }

      const enManos = await tx.pedido.findMany({
        where: { asignadoAId: usuarioId, estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA } },
        select: {
          id: true,
          numeroPedido: true,
          tiendaId: true,
          tiempoAtencionBodegaMs: true,
          bodegaTurnoDesdeAt: true,
        },
      });

      const hechos: { id: number; numeroPedido: string; tiendaId: number }[] = [];
      for (const p of enManos) {
        // La guarda va en el `where`: si otro proceso lo movió entre la lectura y aquí (lo liberó
        // él mismo, lo tomó un admin), no se pisa.
        const { count } = await tx.pedido.updateMany({
          where: { id: p.id, asignadoAId: usuarioId, estado: { in: ESTADOS_OCUPAN_SLOT_BODEGA } },
          data: {
            asignadoAId: null,
            asignadoAt: null,
            ...pausarReloj(
              {
                tiempoAtencionBodegaMs: p.tiempoAtencionBodegaMs ?? 0,
                bodegaTurnoDesdeAt: p.bodegaTurnoDesdeAt ?? null,
              },
              ahora,
            ),
          },
        });
        if (count === 0) continue;
        await tx.historialPedido.create({
          data: {
            pedidoId: p.id,
            estadoAnterior: EstadoPedido.EN_REVISION,
            estadoNuevo: EstadoPedido.EN_REVISION,
            observacion: `Regresó a la cola: ${u.nombre} salió de bodega`,
            usuarioId,
            usuarioNombre: u.nombre,
          },
        });
        hechos.push({ id: p.id, numeroPedido: p.numeroPedido, tiendaId: p.tiendaId });
      }
      return hechos;
    });

    // Realtime DESPUÉS del commit (ver CLAUDE.md: emitir adentro manda el aviso de algo que un
    // rollback puede deshacer). `pedido.liberado` es el mismo evento de "otro bodeguero lo soltó".
    // A la tienda de CADA pedido (un ADMIN no tiene tienda propia y pudo traer pedidos de varias).
    for (const p of regresados) {
      this.realtime.emitToTienda(p.tiendaId, 'pedido.liberado', {
        id: p.id,
        numeroPedido: p.numeroPedido,
        liberadoPor: u.nombre,
      });
      this.realtime.emitToPedido(p.id, 'pedido.liberado', { id: p.id });
    }
    if (!opts.soloPedidos) this.avisar(u.tiendaId, 'bodeguero.salio', usuarioId);

    if (regresados.length > 0) {
      this.logger.log(
        `Bodeguero ${usuarioId} salió: ${regresados.length} pedido(s) regresaron a la cola`,
      );
    }
    return { pedidosRegresados: regresados.length };
  }

  /**
   * Barrido: saca a quien lleva más de 15 min sin latido (cerró la pestaña, se le fue la red, se
   * apagó la tablet). Es la misma salida que cerrar sesión, así que sus pedidos también regresan.
   */
  async salirInactivos(ahora: Date = new Date()): Promise<number> {
    const limite = new Date(ahora.getTime() - INACTIVIDAD_ESTACION_MS);
    const inactivos = await this.prisma.usuario.findMany({
      where: {
        rol: { in: [RolUsuario.BODEGA, RolUsuario.ADMIN] },
        ultimoHeartbeat: { lt: limite },
      },
      select: { id: true },
    });
    for (const { id } of inactivos) await this.salio(id);
    return inactivos.length;
  }

  private avisar(tiendaId: number | null | undefined, evento: string, usuarioId: number) {
    if (tiendaId) this.realtime.emitToTienda(tiendaId, evento, { usuarioId });
  }
}

/** ¿El último latido es lo bastante reciente para darlo por presente? */
export function enLinea(
  ultimoHeartbeat: Date | null | undefined,
  ahora: Date = new Date(),
): boolean {
  return (
    !!ultimoHeartbeat && ahora.getTime() - ultimoHeartbeat.getTime() <= INACTIVIDAD_ESTACION_MS
  );
}
