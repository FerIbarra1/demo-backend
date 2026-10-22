import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { RolUsuario, Prisma, EstadoPedido } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { interpretarFolio } from './folio-erp.util';

/**
 * Shape mínimo del usuario que viaja en `request.user` (lo construye JwtAuthGuard + JwtStrategy).
 * Cualquier método de service que reciba `user` puede pasar a `verificarAccesoPedido`.
 */
export interface PedidoAccessUser {
  userId: number;
  rol: RolUsuario;
  tiendaId?: number;
}

export interface PedidoAccessOptions {
  /**
   * Roles que pueden ver el pedido aunque sea de OTRA tienda (útil para ADMIN).
   * ADMIN siempre pasa. Por defecto solo ADMIN.
   */
  crossTiendaRoles?: RolUsuario[];
  /**
   * Si true, el bodeguero solo puede acceder si el pedido está asignado a él.
   * Aplica solo cuando el rol es BODEGA.
   */
  requiereAsignacionBodega?: boolean;
}

export type PedidoParaVerificar = Prisma.PedidoGetPayload<{
  select: {
    id: true;
    usuarioId: true;
    tiendaId: true;
    asignadoAId: true;
    estado: true;
  };
}>;

/**
 * Servicio utilitario compartido por todos los services que operan sobre
 * un pedido. Centraliza la lógica de "este usuario tiene derecho a ver/operar
 * este pedido" para que ningún controller pueda saltarse la verificación.
 *
 * Reglas:
 * - ADMIN: pasa siempre.
 * - CLIENTE: solo puede ver/operar pedidos donde `pedido.usuarioId === user.userId`.
 * - BODEGA / CAJERO / BODEGA_MONITOR / MOSTRADOR / VENTAS: solo pueden
 *   ver/operar pedidos de su tienda.
 *   Si `requiereAsignacionBodega`, BODEGA también debe tener
 *   `pedido.asignadoAId === user.userId`.
 *
 * F13 (sep 2026): VENTAS entra por la rama de tienda. Hay UN asesor por tienda
 * y atiende la cola de escalados completa, así que NO se le aplica el guard de
 * asignación (que es específico del bodeguero, que sí tiene slots 1:1).
 */
@Injectable()
export class PedidoAccessService {
  constructor(private prisma: PrismaService) {}

  async cargar(pedidoId: number): Promise<PedidoParaVerificar> {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        usuarioId: true,
        tiendaId: true,
        asignadoAId: true,
        estado: true,
      },
    });
    if (!pedido) {
      throw new NotFoundException(`Pedido ${pedidoId} no encontrado`);
    }
    return pedido;
  }

  /**
   * Carga el pedido y valida acceso en una sola llamada.
   * Lanza 404 si no existe, 403 si el usuario no tiene derecho.
   */
  async cargarYValidar(
    pedidoId: number,
    user: PedidoAccessUser,
    opciones: PedidoAccessOptions = {},
  ): Promise<PedidoParaVerificar> {
    const pedido = await this.cargar(pedidoId);
    this.validar(pedido, user, opciones);
    return pedido;
  }

  validar(
    pedido: PedidoParaVerificar,
    user: PedidoAccessUser,
    opciones: PedidoAccessOptions = {},
  ): void {
    const crossTiendaRoles = opciones.crossTiendaRoles ?? [RolUsuario.ADMIN];

    // ADMIN y roles cross-tienda pasan sin verificar tienda.
    if (crossTiendaRoles.includes(user.rol)) {
      return;
    }

    // CLIENTE: debe ser el dueño del pedido. La tienda se valida implícitamente
    // porque cada cliente tiene un pedido en su tienda.
    if (user.rol === RolUsuario.CLIENTE) {
      if (pedido.usuarioId !== user.userId) {
        throw new ForbiddenException('No tienes permiso para acceder a este pedido');
      }
      return;
    }

    // BODEGA / CAJERO / BODEGA_MONITOR: el pedido debe pertenecer a su tienda.
    // La tienda se toma SOLO del JWT/BD (user.tiendaId), nunca de un header
    // client-side (X-Tienda-Id) — confiar en el header permitiría IDOR
    // cross-tienda (un operador de tienda A operando pedidos de tienda B).
    const tiendaEfectiva = user.tiendaId;
    if (!tiendaEfectiva) {
      throw new ForbiddenException(
        'Tu usuario no tiene tienda asignada. Contacta al administrador.',
      );
    }
    if (pedido.tiendaId !== tiendaEfectiva) {
      throw new ForbiddenException('Este pedido pertenece a otra tienda');
    }

    // BODEGA: si se requiere asignación, el pedido debe estar asignado a él.
    if (opciones.requiereAsignacionBodega && user.rol === RolUsuario.BODEGA) {
      if (pedido.asignadoAId === null) {
        throw new ForbiddenException('Este pedido no está asignado. Tómalo antes de operarlo.');
      }
      if (pedido.asignadoAId !== user.userId) {
        throw new ForbiddenException('Este pedido está asignado a otro bodeguero');
      }
    }
  }

  /**
   * Busca un pedido por lo que el empleado teclea o escanea y valida que tenga derecho a verlo. Lanza 404 si no existe y
   * 403 si el pedido es de otra tienda.
   *
   * Oct 2026 (B2): acepta el FOLIO del Sistema Comercial en cualquiera de sus formas —`HMO-0000152573`, `0000152573` (lo
   * que lleva el QR para el lector de VFP) o `152573` (como lo dice la gente)— además del número interno (`PD-…`) y el
   * folio que guardó la bandeja de envío.
   *
   * **El folio solo identifica un pedido junto con su tienda**: el consecutivo es por tienda y el mismo número existe en
   * cada una. Por eso se busca primero DENTRO de la tienda del empleado (sale del JWT, nunca de lo que escribió); un ADMIN,
   * que no trae tienda, ve la ambigüedad si el folio existe en varias y no escribió la serie.
   */
  async buscarPorFolio(
    folio: string,
    user: PedidoAccessUser,
  ): Promise<{
    id: number;
    numeroPedido: string;
    externalFolio: string | null;
    estado: EstadoPedido;
  }> {
    const f = (folio ?? '').trim();
    if (!f) {
      throw new NotFoundException('Folio requerido');
    }

    const incluir = {
      pendienteEnvio: { select: { externalFolio: true, externalIdPEDIDOS: true } },
    } as const;

    // 1) El folio del Sistema Comercial, acotado a la tienda del empleado (o a la serie tecleada).
    const parseado = interpretarFolio(f);
    let pedido = null;
    // Un empleado sin tienda (que no es ADMIN) no busca por folio: sin tienda el número no identifica nada, y `validar`
    // lo rechaza (403) más abajo, como siempre.
    if (parseado && (user.rol === RolUsuario.ADMIN || user.tiendaId)) {
      const dondeFolio: Prisma.PedidoWhereInput = { folioErp: parseado.folio };
      if (user.tiendaId && user.rol !== RolUsuario.ADMIN) {
        dondeFolio.tiendaId = user.tiendaId;
      } else if (parseado.serie) {
        dondeFolio.tienda = { serie: parseado.serie };
      }
      const candidatos = await this.prisma.pedido.findMany({
        where: dondeFolio,
        include: { ...incluir, tienda: { select: { serie: true } } },
        take: 3,
      });
      if (candidatos.length > 1) {
        const series = candidatos.map((c) => c.tienda?.serie).filter(Boolean);
        throw new BadRequestException(
          'Ese folio existe en varias tiendas' +
            (series.length ? ` (${series.join(', ')})` : '') +
            ': escribe también la serie, por ejemplo HMO-0000152573.',
        );
      }
      pedido = candidatos[0] ?? null;
    }

    // 2) El número interno (PD-…) y el folio que guardó la bandeja de envío (como siempre).
    if (!pedido) {
      pedido = await this.prisma.pedido.findFirst({
        where: {
          OR: [
            { numeroPedido: { equals: f, mode: 'insensitive' } },
            { pendienteEnvio: { externalFolio: { equals: f, mode: 'insensitive' } } },
          ],
        },
        include: incluir,
      });
    }

    if (!pedido) {
      throw new NotFoundException('Pedido no encontrado');
    }

    // Valida tienda (y rol). Lanza 403 si el pedido es de otra tienda.
    this.validar(pedido, user);

    return {
      id: pedido.id,
      numeroPedido: pedido.numeroPedido,
      externalFolio: pedido.pendienteEnvio?.externalFolio ?? null,
      estado: pedido.estado,
    };
  }
}
