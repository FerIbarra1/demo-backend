import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ActualizarKioskoDto } from './dto/actualizar-kiosko.dto';
import { EstadoKiosko, Prisma, RolUsuario } from '@prisma/client';
import { calcularSaludKiosko, resumirSalud } from './kiosko-salud';

/**
 * Por qué falló la validación del device token. Ver
 * `validarDeviceTokenConMotivo`.
 */
export type MotivoTokenInvalido = 'SIN_TOKEN' | 'TOKEN_INVALIDO' | 'KIOSKO_INACTIVO';

/** Quién pide: el ADMIN opera cualquier tienda; el GERENTE solo la suya (la tienda sale de su token). */
export interface ActorKiosko {
  userId: number;
  rol: RolUsuario;
  tiendaId?: number | null;
}

/** Lo que el heartbeat lee y devuelve de un kiosko (ver `respuestaHeartbeat`). */
const SELECT_HEARTBEAT = {
  id: true,
  ultimoHeartbeat: true,
  estado: true,
  nombre: true,
  tiendaId: true,
  tienda: { select: { nombre: true } },
} satisfies Prisma.KioskoSelect;

/**
 * Servicio del módulo kiosko.
 *
 * Un kiosko es una tablet física en una tienda donde los clientes hacen pedidos usando SU propia cuenta (no hay
 * cuenta kiosko compartida). Pertenece a UNA tienda y no cambia de tienda nunca.
 *
 * Ciclo de vida (oct 2026, simplificado):
 *  1. El ADMIN —o el GERENTE, solo en su tienda— da de alta el kiosko: el sistema le pone el nombre ("Kiosko 1",
 *     "Kiosko 2"…) y queda ACTIVO pero SIN tablet ("pendiente de instalar").
 *  2. La tablet abre `/kiosko`, muestra un código y quien administra lo autoriza (`KioskoPairingService`): ahí
 *     recibe su token. Es la ÚNICA forma de entregar un token.
 *  3. La tablet late cada 60 s con ese token; cada latido le dice quién es según el servidor.
 *  4. Para apagarlo: estado INACTIVO (reversible). Para desvincular la tablet (robada, reemplazada): `desvincular`
 *     borra el token y la tablet vuelve sola a pedir emparejamiento.
 */
@Injectable()
export class KioskoService {
  private readonly logger = new Logger(KioskoService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * La tienda sobre la que puede actuar el actor. El GERENTE solo la suya (sale de su token, nunca de la
   * petición); el ADMIN la que elija. `null` = "todas" (solo el ADMIN, solo al listar).
   */
  private tiendaDelActor(actor: ActorKiosko, pedida?: number | null): number | null {
    if (actor.rol === RolUsuario.GERENTE) {
      if (!actor.tiendaId) throw new ForbiddenException('Tu usuario no tiene tienda asignada.');
      return actor.tiendaId;
    }
    return pedida ?? null;
  }

  /** Carga un kiosko comprobando que el actor puede tocarlo. Para otro gerente es un 404, no un 403 (no revela ids). */
  private async cargarParaActor(kioskoId: number, actor: ActorKiosko) {
    const kiosko = await this.prisma.kiosko.findUnique({ where: { id: kioskoId } });
    if (!kiosko || (actor.rol === RolUsuario.GERENTE && kiosko.tiendaId !== actor.tiendaId)) {
      throw new NotFoundException('Kiosko no encontrado');
    }
    return kiosko;
  }

  /** "Kiosko N": el siguiente número libre de la tienda. Los nombres que no siguen el patrón se ignoran. */
  private async siguienteNombre(tiendaId: number): Promise<string> {
    const existentes = await this.prisma.kiosko.findMany({
      where: { tiendaId },
      select: { nombre: true },
    });
    const usados = existentes
      .map((k) => /^Kiosko (\d+)$/.exec(k.nombre)?.[1])
      .filter((n): n is string => !!n)
      .map(Number);
    return `Kiosko ${Math.max(0, ...usados) + 1}`;
  }

  /**
   * Da de alta un kiosko en una tienda. El nombre lo pone el sistema. Queda ACTIVO y sin tablet: el token lo
   * entrega el emparejamiento.
   *
   * Dos altas a la vez calcularían el mismo número: la unicidad `(tiendaId, nombre)` hace perder a una, que
   * reintenta con el siguiente.
   */
  async crear(actor: ActorKiosko, dto: { tiendaId?: number; ubicacion?: string }) {
    const tiendaId = this.tiendaDelActor(actor, dto.tiendaId);
    if (!tiendaId) throw new BadRequestException('Elige la tienda del kiosko');
    // Un gerente no puede dar de alta en otra tienda ni "por equivocación": si manda una distinta, 403.
    if (actor.rol === RolUsuario.GERENTE && dto.tiendaId && dto.tiendaId !== tiendaId) {
      throw new ForbiddenException('Solo puedes dar de alta kioskos de tu tienda.');
    }
    const tienda = await this.prisma.tienda.findFirst({ where: { id: tiendaId, activa: true } });
    if (!tienda) throw new NotFoundException('Tienda no encontrada o inactiva');

    for (let intento = 0; ; intento++) {
      try {
        const creado = await this.prisma.kiosko.create({
          data: {
            tiendaId,
            nombre: await this.siguienteNombre(tiendaId),
            ubicacion: dto.ubicacion?.trim() || null,
            estado: EstadoKiosko.ACTIVO,
            activadoPorId: actor.userId,
          },
          include: this.includeCompleto,
        });
        this.logger.log(
          `Kiosko ${creado.id} (${creado.nombre}) dado de alta por usuario ${actor.userId}`,
        );
        return creado;
      } catch (err) {
        const choque = (err as { code?: string }).code === 'P2002';
        if (!choque || intento >= 4) throw err;
      }
    }
  }

  /**
   * Cambia la ubicación y/o el estado (el interruptor). Pasar a INACTIVO anota quién y cuándo; volver a ACTIVO lo
   * borra. El nombre y la tienda NO se editan.
   */
  async actualizar(kioskoId: number, dto: ActualizarKioskoDto, actor: ActorKiosko) {
    const kiosko = await this.cargarParaActor(kioskoId, actor);

    const data: Prisma.KioskoUpdateInput = {};
    if (dto.ubicacion !== undefined) data.ubicacion = dto.ubicacion.trim() || null;

    if (dto.estado !== undefined && dto.estado !== kiosko.estado) {
      data.estado = dto.estado;
      if (dto.estado === EstadoKiosko.INACTIVO) {
        data.desactivadoAt = new Date();
        data.desactivadoPor = { connect: { id: actor.userId } };
      } else {
        data.activadoAt = new Date();
        data.activadoPor = { connect: { id: actor.userId } };
        data.desactivadoAt = null;
        data.desactivadoPor = { disconnect: true };
      }
    }

    if (Object.keys(data).length === 0) {
      return this.prisma.kiosko.findUniqueOrThrow({
        where: { id: kioskoId },
        include: this.includeCompleto,
      });
    }

    const actualizado = await this.prisma.kiosko.update({
      where: { id: kioskoId },
      data,
      include: this.includeCompleto,
    });
    this.logger.log(
      `Kiosko ${kioskoId} actualizado por usuario ${actor.userId} (${Object.keys(data).join(', ')})`,
    );
    return actualizado;
  }

  /**
   * Quita el token del kiosko: la tablet que lo tenía (robada, reemplazada, desconfigurada) deja de poder operar
   * al instante y, al recibir el rechazo, pide emparejarse sola. El kiosko NO se borra: sus pedidos conservan la
   * trazabilidad y se puede vincular otra tablet al mismo.
   */
  async desvincular(kioskoId: number, actor: ActorKiosko) {
    await this.cargarParaActor(kioskoId, actor);
    const actualizado = await this.prisma.kiosko.update({
      where: { id: kioskoId },
      data: { deviceTokenHash: null, deviceTokenCreadoAt: null },
      include: this.includeCompleto,
    });
    this.logger.log(`Kiosko ${kioskoId}: tablet desvinculada por usuario ${actor.userId}`);
    return actualizado;
  }

  /**
   * Latido del kiosko: actualiza `ultimoHeartbeat` y le dice a la tablet quién es según el servidor. El controller
   * ya validó el token y que el kiosko esté ACTIVO.
   */
  async heartbeat(kioskoId: number) {
    const kiosko = await this.prisma.kiosko.findUnique({
      where: { id: kioskoId },
      select: { id: true, estado: true },
    });
    if (!kiosko) throw new NotFoundException('Kiosko no encontrado');
    if (kiosko.estado !== EstadoKiosko.ACTIVO) throw new BadRequestException('Kiosko inactivo');

    const actualizado = await this.prisma.kiosko.update({
      where: { id: kioskoId },
      data: { ultimoHeartbeat: new Date() },
      select: SELECT_HEARTBEAT,
    });
    return this.respuestaHeartbeat(actualizado);
  }

  /**
   * Lista kioskos con su estado de SALUD derivado. La salud se calcula aquí (no en el frontend) para que todos los
   * clientes coincidan; distingue "el admin lo apagó" de "la tablet se cayó" porque piden acciones distintas.
   * El GERENTE solo ve los de su tienda; el ADMIN, todos o los de la tienda que pida.
   */
  async listar(actor: ActorKiosko, filtros?: { tiendaId?: number; estado?: EstadoKiosko }) {
    const where: Prisma.KioskoWhereInput = {};
    const tiendaId = this.tiendaDelActor(actor, filtros?.tiendaId);
    if (tiendaId) where.tiendaId = tiendaId;
    if (filtros?.estado) where.estado = filtros.estado;

    const kioskos = await this.prisma.kiosko.findMany({
      where,
      include: this.includeCompleto,
      orderBy: [{ tiendaId: 'asc' }, { nombre: 'asc' }],
    });

    const ahora = Date.now();
    const conSalud = kioskos.map((k) => ({
      ...k,
      salud: calcularSaludKiosko(k, ahora),
    }));

    return {
      kioskos: conSalud,
      resumen: resumirSalud(conSalud),
    };
  }

  /** Helper interno para includes repetidos. */
  private get includeCompleto() {
    return {
      tienda: { select: { id: true, nombre: true, direccion: true, ciudad: true } },
      activadoPor: { select: { id: true, nombre: true, apellido: true, email: true } },
      desactivadoPor: { select: { id: true, nombre: true, apellido: true, email: true } },
    } satisfies Prisma.KioskoInclude;
  }

  /** SHA-256 del token. La BD guarda solo el hash; el claro lo tiene únicamente la tablet. */
  private hashDeviceToken(tokenPlano: string): string {
    return createHash('sha256').update(tokenPlano).digest('hex');
  }

  /**
   * Respuesta del heartbeat: además del latido, la IDENTIDAD que el servidor conoce de esta tablet.
   *
   * La tablet guarda en su localStorage a qué kiosko y tienda pertenece; cada latido se la confirma. Si no
   * coincide, GANA EL SERVIDOR (la tablet nunca decide a qué tienda pertenece: el kiosko tiene `tiendaId` fijo
   * en la BD y nada lo cambia).
   */
  private respuestaHeartbeat(k: Prisma.KioskoGetPayload<{ select: typeof SELECT_HEARTBEAT }>) {
    return {
      kioskoId: k.id,
      ultimoHeartbeat: k.ultimoHeartbeat,
      estado: k.estado,
      nombre: k.nombre,
      tiendaId: k.tiendaId,
      tiendaNombre: k.tienda.nombre,
    };
  }

  /**
   * Validación constante-tiempo del `X-Kiosko-Token` enviado por la tablet. Devuelve true solo si el kiosko
   * existe, está ACTIVO y el hash guardado coincide con el del token enviado. Un kiosko sin token (nunca
   * vinculado, o desvinculado) nunca valida.
   */
  async validarDeviceToken(kioskoId: number, tokenPlano: string | undefined): Promise<boolean> {
    const resultado = await this.validarDeviceTokenConMotivo(kioskoId, tokenPlano);
    return resultado.valido;
  }

  /**
   * Igual que `validarDeviceToken`, pero distingue POR QUÉ falló:
   *  - `SIN_TOKEN`: la tablet no mandó el header.
   *  - `TOKEN_INVALIDO`: mandó uno que no coincide con el hash guardado (o el kiosko ya no tiene token).
   *  - `KIOSKO_INACTIVO`: el token es correcto, pero el kiosko está apagado.
   * Las dos primeras son fallos de credenciales (401); la tercera es un conflicto de estado (409).
   *
   * Nota de seguridad: el token se verifica ANTES de revelar el estado del kiosko, para que quien enumera ids no
   * pueda usar el código de respuesta como oráculo de qué kioskos existen y están activos.
   */
  async validarDeviceTokenConMotivo(
    kioskoId: number,
    tokenPlano: string | undefined,
  ): Promise<{ valido: boolean; motivo?: MotivoTokenInvalido }> {
    if (!tokenPlano || typeof tokenPlano !== 'string') {
      return { valido: false, motivo: 'SIN_TOKEN' };
    }
    const kiosko = await this.prisma.kiosko.findUnique({
      where: { id: kioskoId },
      select: { deviceTokenHash: true, estado: true },
    });
    if (!kiosko) return { valido: false, motivo: 'TOKEN_INVALIDO' };
    if (!kiosko.deviceTokenHash) return { valido: false, motivo: 'TOKEN_INVALIDO' };

    const hashDado = this.hashDeviceToken(tokenPlano);
    // timingSafeEqual requiere buffers del mismo largo. Si el hash guardado está malformado, se devuelve false.
    let a: Buffer, b: Buffer;
    try {
      a = Buffer.from(hashDado, 'hex');
      b = Buffer.from(kiosko.deviceTokenHash, 'hex');
    } catch {
      return { valido: false, motivo: 'TOKEN_INVALIDO' };
    }
    if (a.length !== b.length) return { valido: false, motivo: 'TOKEN_INVALIDO' };
    if (!timingSafeEqual(a, b)) return { valido: false, motivo: 'TOKEN_INVALIDO' };

    // Token correcto: ahora sí es seguro revelar el estado.
    if (kiosko.estado !== EstadoKiosko.ACTIVO) {
      return { valido: false, motivo: 'KIOSKO_INACTIVO' };
    }
    return { valido: true };
  }
}
