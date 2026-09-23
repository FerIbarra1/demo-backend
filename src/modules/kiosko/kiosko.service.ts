import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivarKioskoDto } from './dto/activar-kiosko.dto';
import { ActualizarKioskoDto } from './dto/actualizar-kiosko.dto';
import { EstadoKiosko, Prisma } from '@prisma/client';
import { calcularSaludKiosko, resumirSalud } from './kiosko-salud';

/**
 * Por qué falló la validación del device token. Ver
 * `validarDeviceTokenConMotivo`.
 */
export type MotivoTokenInvalido = 'SIN_TOKEN' | 'TOKEN_INVALIDO' | 'KIOSKO_INACTIVO';

/**
 * Servicio del módulo kiosko.
 *
 * Un kiosko es una tablet física en una tienda donde los clientes hacen
 * pedidos usando SU propia cuenta (no hay cuenta kiosko compartida). El
 * kiosko sólo aporta trazabilidad: cada pedido guardará kioskoId.
 *
 * Flujo:
 * 1. ADMIN da de alta kiosko para tienda + nombre → kiosko en BD INACTIVO
 *    (sin tablet aún). El nombre del admin activador queda registrado en
 *    `activadoPorId` (trazabilidad del alta), pero `primerConexionAt` queda NULL.
 * 2. La tablet abre `/kiosko/[tiendaId]` y el primer `heartbeat` público
 *    dispara la transición INACTIVO → ACTIVO + setea `primerConexionAt`.
 * 3. Cada cliente hace login con sus credenciales y pide normalmente.
 * 4. Al pedir, frontend manda header `X-Kiosko-Id`; backend lo valida y
 *    fuerza `canalOrigen=KIOSKO` + `kioskoId=...`.
 * 5. La tablet hace heartbeat cada 60s; admin ve "último heartbeat".
 * 6. ADMIN desactiva kiosko cuando quiere apagarlo (pasa a INACTIVO con
 *    `desactivadoAt` poblado; un heartbeat posterior no lo reactiva).
 */
@Injectable()
export class KioskoService {
  private readonly logger = new Logger(KioskoService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Da de alta un kiosko para una tienda con un nombre. Lo crea INACTIVO
   * (sin tablet aún). Si ya existe uno con ese nombre en la tienda, lanza
   * 409 sin importar su estado. La transición INACTIVO → ACTIVO la dispara
   * la tablet en su primer heartbeat (ver `heartbeat()`).
   *
   * Si el admin quiere reactivar manualmente un kiosko INACTIVO sin esperar
   * a la tablet, lo hace vía PATCH `/kiosko/:id` con `{ estado: 'ACTIVO' }`
   * (ver `actualizar()`).
   */
  async activar(dto: ActivarKioskoDto, adminUserId: number) {
    const tienda = await this.prisma.tienda.findFirst({
      where: { id: dto.tiendaId, activa: true },
    });
    if (!tienda) {
      throw new NotFoundException('Tienda no encontrada o inactiva');
    }

    const existente = await this.prisma.kiosko.findUnique({
      where: { tiendaId_nombre: { tiendaId: dto.tiendaId, nombre: dto.nombre } },
    });

    if (existente) {
      // Ya hay un kiosko con ese nombre (activo o inactivo) en esta tienda.
      // La unicidad por (tiendaId, nombre) es absoluta, no por estado.
      throw new ConflictException(
        `Ya existe un kiosko con el nombre "${dto.nombre}" en esta tienda (estado: ${existente.estado})`,
      );
    }

    // PR2 (kiosko-profesional): al activar un kiosko generamos su
    // `deviceToken` (token de larga vida, sha256-hash en BD, claro solo
    // devuelto al admin UNA VEZ). La tablet lo guarda en localStorage y
    // lo manda en `X-Kiosko-Token` para probar que es ella. Sin este
    // token, el header `X-Kiosko-Id` solo prueba que alguien conoce un
    // kioskoId adivinado.
    const deviceTokenPlain = this.generarDeviceTokenPlano();
    const deviceTokenHash = this.hashDeviceToken(deviceTokenPlain);

    const creado = await this.prisma.kiosko.create({
      data: {
        tiendaId: dto.tiendaId,
        nombre: dto.nombre,
        estado: EstadoKiosko.INACTIVO,
        activadoPorId: adminUserId,
        deviceTokenHash,
        deviceTokenCreadoAt: new Date(),
        // primerConexionAt queda null: se setea en el primer heartbeat.
        // ultimoHeartbeat queda null: la tablet aún no se conectó.
      },
      include: this.includeCompleto,
    });
    this.logger.log(
      `Kiosko ${creado.id} dado de alta por admin ${adminUserId} (pendiente de primera conexión)`,
    );
    // Devolvemos el kiosko + el token en claro. El controller decide si
    // exponerlo en la API pública (lo exponemos solo en alta/regenerar,
    // nunca en listar/obtener).
    return { ...creado, deviceTokenPlain };
  }

  /**
   * Desactiva un kiosko. NO elimina pedidos históricos (trazabilidad).
   *
   * PR3 (kiosko-profesional): idempotente. Si ya estaba INACTIVO,
   * devolvemos la fila actual sin error. Antes lanzaba 400, lo que
   * rompía el caso "admin hace click en Desactivar dos veces" y el
   * caso "kiosko recién creado por el admin está INACTIVO y el botón
   * Desactivar salta error sin haberlo desactivado antes".
   */
  async desactivar(kioskoId: number, adminUserId: number) {
    const kiosko = await this.prisma.kiosko.findUnique({ where: { id: kioskoId } });
    if (!kiosko) {
      throw new NotFoundException('Kiosko no encontrado');
    }
    if (kiosko.estado === EstadoKiosko.INACTIVO) {
      // Idempotente: devolver la fila actual sin re-marcar timestamps.
      return this.prisma.kiosko.findUniqueOrThrow({
        where: { id: kioskoId },
        include: this.includeCompleto,
      });
    }

    const actualizado = await this.prisma.kiosko.update({
      where: { id: kioskoId },
      data: {
        estado: EstadoKiosko.INACTIVO,
        desactivadoAt: new Date(),
        desactivadoPorId: adminUserId,
      },
      include: this.includeCompleto,
    });
    this.logger.log(`Kiosko ${kioskoId} desactivado por admin ${adminUserId}`);
    return actualizado;
  }

  /**
   * Actualiza nombre y/o estado de un kiosko existente.
   * - Si cambia el nombre, valida unicidad por tienda.
   * - Si cambia a INACTIVO, registra desactivadoAt/Por.
   * - Si reactiva (INACTIVO → ACTIVO), resetea timestamps y ultimoHeartbeat.
   */
  async actualizar(kioskoId: number, dto: ActualizarKioskoDto, adminUserId: number) {
    const kiosko = await this.prisma.kiosko.findUnique({ where: { id: kioskoId } });
    if (!kiosko) {
      throw new NotFoundException('Kiosko no encontrado');
    }

    // Validar unicidad de nombre si cambia
    if (dto.nombre !== undefined && dto.nombre !== kiosko.nombre) {
      const duplicado = await this.prisma.kiosko.findUnique({
        where: {
          tiendaId_nombre: { tiendaId: kiosko.tiendaId, nombre: dto.nombre },
        },
      });
      if (duplicado && duplicado.id !== kioskoId) {
        throw new ConflictException(
          `Ya existe un kiosko con nombre "${dto.nombre}" en esta tienda`,
        );
      }
    }

    const data: Prisma.KioskoUpdateInput = {};

    if (dto.nombre !== undefined) {
      data.nombre = dto.nombre;
    }

    if (dto.estado !== undefined && dto.estado !== kiosko.estado) {
      data.estado = dto.estado;
      if (dto.estado === EstadoKiosko.INACTIVO) {
        data.desactivadoAt = new Date();
        data.desactivadoPor = { connect: { id: adminUserId } };
      } else if (dto.estado === EstadoKiosko.ACTIVO) {
        // Reactivación
        data.activadoAt = new Date();
        data.activadoPor = { connect: { id: adminUserId } };
        data.desactivadoAt = null;
        data.desactivadoPor = { disconnect: true };
        data.ultimoHeartbeat = null;
      }
    }

    if (Object.keys(data).length === 0) {
      // No hay cambios
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
      `Kiosko ${kioskoId} actualizado por admin ${adminUserId} (cambios: ${Object.keys(data).join(', ')})`,
    );
    return actualizado;
  }

  /**
   * Heartbeat del kiosko: actualiza ultimoHeartbeat.
   *
   * Si el kiosko está INACTIVO con `primerConexionAt` null (recién dado de
   * alta por admin, sin tablet aún), este primer heartbeat dispara la
   * transición INACTIVO → ACTIVO + setea `primerConexionAt`. Reusa el
   * `activadoPorId` del alta original para no perder la trazabilidad de
   * "qué admin dio de alta este kiosko".
   *
   * Si el kiosko está INACTIVO pero ya tuvo `primerConexionAt` (es decir,
   * estuvo activo y luego fue desactivado por admin), devuelve 400 para
   * preservar la semántica de "desactivar = apagar".
   */
  async heartbeat(kioskoId: number) {
    const kiosko = await this.prisma.kiosko.findUnique({ where: { id: kioskoId } });
    if (!kiosko) {
      throw new NotFoundException('Kiosko no encontrado');
    }

    const now = new Date();

    if (kiosko.estado === EstadoKiosko.ACTIVO) {
      // Path normal: kiosko ya activo, sólo actualizar heartbeat.
      const actualizado = await this.prisma.kiosko.update({
        where: { id: kioskoId },
        data: { ultimoHeartbeat: now },
        select: { id: true, ultimoHeartbeat: true, estado: true },
      });
      return {
        kioskoId: actualizado.id,
        ultimoHeartbeat: actualizado.ultimoHeartbeat,
        estado: actualizado.estado,
        recienActivado: false,
      };
    }

    if (
      kiosko.estado === EstadoKiosko.INACTIVO &&
      kiosko.desactivadoAt === null
    ) {
      // El kiosko está INACTIVO pero el admin nunca lo desactivó
      // explícitamente. Reactivamos por heartbeat. Cubre dos casos:
      // 1) Primera conexión: kiosko dado de alta por admin, nunca
      //    encendido. `primerConexionAt` es null, lo seteamos ahora.
      // 2) Kiosko legacy que estuvo activo, se desactivó
      //    programáticamente (e.g. prueba anterior), `desactivadoAt`
      //    quedó en null porque nunca se llamó desactivar() — se
      //    reactiva porque la tablet lo está pidiendo.
      // Si `desactivadoAt` tuviera valor, es un kiosko que el admin
      // desactivó intencionalmente; NO se reactiva automáticamente.
      const isPrimeraConexion = kiosko.primerConexionAt === null;
      const actualizado = await this.prisma.kiosko.update({
        where: { id: kioskoId },
        data: {
          estado: EstadoKiosko.ACTIVO,
          ultimoHeartbeat: now,
          // Si es primera conexión, setea primerConexionAt. Si ya
          // tenía, no lo toca (preserva la trazabilidad de cuándo se
          // conectó por primera vez).
          ...(isPrimeraConexion ? { primerConexionAt: now } : {}),
        },
        select: { id: true, ultimoHeartbeat: true, estado: true },
      });
      this.logger.log(
        `Kiosko ${kioskoId} ${isPrimeraConexion ? 'activado por primera conexión' : 'reactivado'} (heartbeat)`,
      );
      return {
        kioskoId: actualizado.id,
        ultimoHeartbeat: actualizado.ultimoHeartbeat,
        estado: actualizado.estado,
        recienActivado: true,
      };
    }

    // INACTIVO con desactivadoAt no null: admin lo desactivó
    // intencionalmente. No se reactiva.
    throw new BadRequestException('Kiosko inactivo');
  }

  /**
   * Lista kioskos con filtros opcionales.
   */
  /**
   * Lista kioskos con su estado de SALUD derivado.
   *
   * La salud se calcula aquí (no en el frontend) para que todos los clientes
   * coincidan y el panel no tenga que re-derivar reglas. Distingue
   * explícitamente "el admin lo apagó" de "la tablet se cayó": son problemas
   * con soluciones distintas y confundirlos hacía que el admin no supiera si
   * actuar o no.
   */
  async listar(filtros?: { tiendaId?: number; estado?: EstadoKiosko }) {
    const where: Prisma.KioskoWhereInput = {};
    if (filtros?.tiendaId) where.tiendaId = filtros.tiendaId;
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

  /**
   * Devuelve el kiosko activo de una tienda. Si hay varios, devuelve el
   * primero por nombre. Usado por la tablet en /kiosko/[tiendaId] para
   * validar que existe kiosko antes de mostrar login.
   */
  async obtenerActivoPorTienda(tiendaId: number) {
    const kiosko = await this.prisma.kiosko.findFirst({
      where: { tiendaId, estado: EstadoKiosko.ACTIVO },
      include: { tienda: { select: { id: true, nombre: true } } },
      orderBy: { nombre: 'asc' },
    });
    if (!kiosko) {
      throw new NotFoundException('Esta tienda no tiene un kiosko activo');
    }
    return kiosko;
  }

  /**
   * Helper interno para includes repetidos en listar/activar/desactivar.
   */
  private get includeCompleto() {
    return {
      tienda: { select: { id: true, nombre: true, direccion: true, ciudad: true } },
      activadoPor: { select: { id: true, nombre: true, apellido: true, email: true } },
      desactivadoPor: { select: { id: true, nombre: true, apellido: true, email: true } },
    } satisfies Prisma.KioskoInclude;
  }

  /**
   * PR2 (kiosko-profesional): genera un token opaco de larga vida.
   * 32 bytes random → base64url (43 chars). El hash se persiste; el
   * claro se devuelve UNA sola vez al admin y nunca vuelve a salir.
   */
  private generarDeviceTokenPlano(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * PR2: hashea el token con SHA-256. La BD guarda solo el hash; el
   * admin lo pega en la tablet y la tablet lo manda en cada request.
   */
  private hashDeviceToken(tokenPlano: string): string {
    return createHash('sha256').update(tokenPlano).digest('hex');
  }

  /**
   * PR2: regenera el device token de un kiosko existente. El anterior
   * queda invalidado al instante — la tablet vieja deja de poder mandar
   * heartbeat hasta que el admin le pegue el nuevo token.
   *
   * Pensado para:
   *  - kioskos legacy (device_token_hash IS NULL tras la migración) que
   *    necesitan un token para empezar a operar;
   *  - tablets comprometidas / robadas: el admin regenera desde el panel
   *    y la tablet atacante queda bloqueada.
   */
  async regenerarDeviceToken(kioskoId: number, adminUserId: number): Promise<{ kiosko: any; deviceTokenPlain: string }> {
    const kiosko = await this.prisma.kiosko.findUnique({ where: { id: kioskoId } });
    if (!kiosko) {
      throw new NotFoundException('Kiosko no encontrado');
    }

    const deviceTokenPlain = this.generarDeviceTokenPlano();
    const deviceTokenHash = this.hashDeviceToken(deviceTokenPlain);

    const actualizado = await this.prisma.kiosko.update({
      where: { id: kioskoId },
      data: {
        deviceTokenHash,
        deviceTokenCreadoAt: new Date(),
      },
      include: this.includeCompleto,
    });
    this.logger.log(
      `Device token regenerado para kiosko ${kioskoId} por admin ${adminUserId}`,
    );
    return { kiosko: actualizado, deviceTokenPlain };
  }

  /**
   * PR2: validación constante-tiempo del `X-Kiosko-Token` enviado por
   * la tablet. Devuelve true solo si:
   *  - el kiosko existe;
   *  - está ACTIVO;
   *  - el hash guardado coincide con el del token enviado.
   *
   * Falla silenciosa (false) si el kiosko no tiene token (legacy) — la
   * política es que TODO kiosko debe tener device token; los legacy
   * deben regenerar antes de poder operar (ver validarKioskoParaPedido
   * en cliente.service.ts).
   */
  async validarDeviceToken(kioskoId: number, tokenPlano: string | undefined): Promise<boolean> {
    const resultado = await this.validarDeviceTokenConMotivo(kioskoId, tokenPlano);
    return resultado.valido;
  }

  /**
   * Igual que `validarDeviceToken`, pero distingue POR QUÉ falló.
   *
   * El booleano colapsaba tres causas que el cliente necesita separar:
   *  - `SIN_TOKEN`: la tablet no mandó el header.
   *  - `TOKEN_INVALIDO`: mandó uno que no coincide con el hash guardado.
   *  - `KIOSKO_INACTIVO`: el token es correcto, pero el admin apagó el kiosko.
   *
   * Las dos primeras son fallos de credenciales (401); la tercera es un
   * conflicto de estado (409). Sin esta distinción el frontend mostraba
   * "token inválido" a un operador cuyo kiosko simplemente estaba apagado.
   *
   * Nota de seguridad: el orden de las comprobaciones importa. Se verifica
   * el token ANTES de revelar el estado del kiosko, para que un atacante
   * que enumera IDs no pueda usar el código de respuesta como oráculo de
   * qué kioskos existen y están activos.
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
    // timingSafeEqual requiere buffers del mismo largo. Si el hash guardado
    // está malformado por alguna razón, comparamos con un buffer de ceros
    // del largo correcto y devolvemos false (mismo tiempo de respuesta).
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
