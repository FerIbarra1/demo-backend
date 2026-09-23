import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash, randomInt, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { KioskoPairingEstado, EstadoKiosko } from '@prisma/client';

/**
 * Emparejamiento de tablets con kioskos.
 *
 * Resuelve el caso en que una tablet PERDIÓ su credencial: actualización de la
 * app, borrado de almacenamiento, reinstalación. El personal de tienda no puede
 * recuperarla (la tablet está instalada como app y no puede navegar a ajustes),
 * así que la recuperación es remota y la inicia el admin.
 *
 * Flujo:
 *   1. La tablet, sin credencial, pide un emparejamiento. El backend genera un
 *      CÓDIGO de 6 dígitos y lo devuelve; la tablet lo muestra en pantalla.
 *   2. El encargado lee el código al admin; el admin lo teclea en su panel.
 *   3. El admin autoriza y elige a qué kiosko pertenece esa tablet.
 *   4. La tablet reclama el device token y se configura sola.
 *
 * SEGURIDAD — el código NO es la credencial:
 *  - Un código de 6 dígitos es adivinable (10^6) y además es audible/visible:
 *    cualquiera en la tienda puede leerlo de la pantalla.
 *  - Lo que AUTORIZA el reclamo es `deviceSecret`: un secreto de 32 bytes que
 *    la tablet genera y NUNCA sale de su memoria. El código sólo sirve para que
 *    el admin correlacione la solicitud con la tablet que tiene enfrente.
 *  - Sin el `deviceSecret`, conocer el `pairingId` (o el código) no alcanza
 *    para reclamar el token.
 *  - Los intentos fallidos se cuentan POR CÓDIGO, no por IP: un atacante con
 *    varias IPs no multiplica sus intentos, y 5 fallos queman ese código.
 */
@Injectable()
export class KioskoPairingService {
  private readonly logger = new Logger(KioskoPairingService.name);

  /** Vida del código. Corta a propósito: es un canal de correlación, no una sesión. */
  private static readonly TTL_MS = 5 * 60 * 1000;
  /** Fallos de canje que queman el código, vengan de donde vengan. */
  private static readonly MAX_INTENTOS = 5;

  constructor(private prisma: PrismaService) {}

  private sha256(valor: string): string {
    return createHash('sha256').update(valor).digest('hex');
  }

  /**
   * Compara dos hashes hex en tiempo constante. Devuelve false si alguno está
   * malformado, sin filtrar por qué.
   */
  private hashCoincide(aHex: string, bHex: string): boolean {
    try {
      const a = Buffer.from(aHex, 'hex');
      const b = Buffer.from(bHex, 'hex');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Paso 1: la tablet pide un emparejamiento.
   *
   * Devuelve el código EN CLARO una sola vez (sólo se persiste su hash). El
   * `deviceSecretHash` lo calcula la tablet y lo manda: el secreto en claro
   * nunca viaja en este request ni se guarda.
   */
  async solicitar(datos: {
    deviceSecretHash: string;
    tiendaIdHint?: number;
    kioskoIdHint?: number;
    ip?: string;
    userAgent?: string;
  }): Promise<{ pairingId: string; code: string; expiraAt: Date; pollAfterMs: number }> {
    if (!/^[0-9a-f]{64}$/.test(datos.deviceSecretHash)) {
      throw new BadRequestException('deviceSecretHash inválido');
    }

    // Un solo código vivo por tablet: si la tablet pide otro, el anterior se
    // invalida. Evita que un atacante acumule códigos vivos en paralelo.
    await this.prisma.kioskoPairing.updateMany({
      where: {
        estado: KioskoPairingEstado.PENDIENTE,
        deviceSecretHash: datos.deviceSecretHash,
      },
      data: { estado: KioskoPairingEstado.CANCELADO },
    });

    // `randomInt` es CSPRNG. `Math.random` NO sirve para un código que autoriza
    // la vinculación de un dispositivo.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiraAt = new Date(Date.now() + KioskoPairingService.TTL_MS);

    const pairing = await this.prisma.kioskoPairing.create({
      data: {
        codeHash: this.sha256(code),
        deviceSecretHash: datos.deviceSecretHash,
        estado: KioskoPairingEstado.PENDIENTE,
        tiendaIdHint: datos.tiendaIdHint ?? null,
        kioskoIdHint: datos.kioskoIdHint ?? null,
        ipPrimeraVista: datos.ip ?? null,
        userAgent: datos.userAgent?.slice(0, 255) ?? null,
        expiraAt,
      },
    });

    this.logger.log(`Emparejamiento solicitado: ${pairing.id} (tienda hint ${datos.tiendaIdHint ?? '—'})`);

    return { pairingId: pairing.id, code, expiraAt, pollAfterMs: 3000 };
  }

  /**
   * Paso 2 (admin): busca la solicitud por el código que le leyó el encargado.
   *
   * Devuelve contexto para que el admin confirme que es la tablet correcta
   * (tienda, antigüedad, IP, si el kiosko destino está en línea). NUNCA
   * devuelve el `deviceSecretHash` ni nada que permita reclamar el token.
   *
   * Los errores son uniformes para no revelar si un código existió.
   */
  async buscarPorCodigo(code: string) {
    if (!/^\d{6}$/.test(code)) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    const pairing = await this.prisma.kioskoPairing.findUnique({
      where: { codeHash: this.sha256(code) },
      include: { kiosko: { select: { id: true, nombre: true, tiendaId: true } } },
    });

    if (!pairing || pairing.estado !== KioskoPairingEstado.PENDIENTE) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    if (pairing.expiraAt < new Date()) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    const tiendaId = pairing.tiendaIdHint ?? pairing.kiosko?.tiendaId ?? null;
    const tienda = tiendaId
      ? await this.prisma.tienda.findUnique({
          where: { id: tiendaId },
          select: { id: true, nombre: true },
        })
      : null;

    return {
      pairingId: pairing.id,
      tienda,
      edadSegundos: Math.floor((Date.now() - pairing.createdAt.getTime()) / 1000),
      ip: pairing.ipPrimeraVista,
      userAgent: pairing.userAgent,
      kioskoSugerido: pairing.kiosko,
    };
  }

  /**
   * Paso 3 (admin): autoriza la vinculación a un kiosko concreto.
   *
   * UPDATE condicional PENDIENTE → APROBADO: si dos admins autorizan a la vez,
   * sólo uno gana y el otro recibe 409 (no se emiten dos autorizaciones).
   */
  async aprobar(pairingId: string, kioskoId: number, adminUserId: number) {
    const kiosko = await this.prisma.kiosko.findUnique({
      where: { id: kioskoId },
      select: { id: true, nombre: true, estado: true, ultimoHeartbeat: true, tiendaId: true },
    });
    if (!kiosko) throw new NotFoundException('Kiosko no encontrado');

    const resultado = await this.prisma.kioskoPairing.updateMany({
      where: {
        id: pairingId,
        estado: KioskoPairingEstado.PENDIENTE,
        expiraAt: { gt: new Date() },
      },
      data: {
        estado: KioskoPairingEstado.APROBADO,
        kioskoId,
        aprobadoPorId: adminUserId,
        aprobadoAt: new Date(),
      },
    });

    if (resultado.count !== 1) {
      throw new ConflictException(
        'La solicitud ya no está disponible (expirada, cancelada o ya autorizada)',
      );
    }

    this.logger.log(
      `Emparejamiento ${pairingId} aprobado → kiosko ${kioskoId} por admin ${adminUserId}`,
    );

    // Aviso para el panel: si el kiosko destino está EN LÍNEA, autorizar esta
    // tablet lo va a desconectar (su token viejo queda inválido). El admin debe
    // confirmarlo a sabiendas.
    const kioskoEnLinea =
      !!kiosko.ultimoHeartbeat &&
      Date.now() - kiosko.ultimoHeartbeat.getTime() < 3 * 60 * 1000;

    return { ok: true, kioskoEnLinea, kiosko };
  }

  async cancelar(pairingId: string, adminUserId: number) {
    const resultado = await this.prisma.kioskoPairing.updateMany({
      where: { id: pairingId, estado: KioskoPairingEstado.PENDIENTE },
      data: { estado: KioskoPairingEstado.CANCELADO },
    });
    if (resultado.count !== 1) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    this.logger.log(`Emparejamiento ${pairingId} cancelado por admin ${adminUserId}`);
    return { ok: true };
  }

  /**
   * Paso 4 (tablet): reclama el device token.
   *
   * Exige el `deviceSecret` (lo que AUTORIZA) — no basta el código ni el
   * `pairingId`. El consumo es atómico: un solo request gana, el resto recibe
   * 404 idéntico al de una solicitud inexistente (anti-oráculo).
   */
  async reclamar(
    pairingId: string,
    deviceSecret: string,
  ): Promise<{
    deviceTokenPlain: string;
    kioskoId: number;
    tiendaId: number;
    kioskoNombre: string;
    tiendaNombre: string;
  }> {
    if (!deviceSecret) throw new NotFoundException('Solicitud no encontrada');

    const pairing = await this.prisma.kioskoPairing.findUnique({
      where: { id: pairingId },
      include: { kiosko: { include: { tienda: { select: { id: true, nombre: true } } } } },
    });

    // Mismo 404 para "no existe", "ya reclamado" y "cancelado": un atacante no
    // puede distinguir estados ni confirmar que un pairingId existió.
    if (!pairing) throw new NotFoundException('Solicitud no encontrada');

    // El secreto se valida SIEMPRE (aunque el estado no sea APROBADO), para no
    // revelar por timing ni por código de respuesta si el pairing existe.
    const secretoOk = this.hashCoincide(this.sha256(deviceSecret), pairing.deviceSecretHash);
    if (!secretoOk) {
      await this.prisma.kioskoPairing.update({
        where: { id: pairing.id },
        data: { intentosFallidos: { increment: 1 } },
      });
      throw new NotFoundException('Solicitud no encontrada');
    }

    if (pairing.intentosFallidos >= KioskoPairingService.MAX_INTENTOS) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    if (pairing.estado !== KioskoPairingEstado.APROBADO) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    if (pairing.expiraAt < new Date()) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    if (!pairing.kiosko) {
      throw new NotFoundException('Solicitud no encontrada');
    }
    if (pairing.kiosko.estado !== EstadoKiosko.ACTIVO) {
      // El kiosko está apagado: no se emite credencial. El admin debe
      // reactivarlo primero (así el orden de las acciones es explícito).
      throw new ForbiddenException(
        'El kiosko está inactivo. Reactívalo antes de vincular la tablet.',
      );
    }

    const deviceTokenPlain = randomBytes(32).toString('base64url');

    // Consumo atómico + emisión del token en una sola transacción: si dos
    // requests llegan a la vez, sólo uno pasa el UPDATE condicional y emite.
    const resultado = await this.prisma.$transaction(async (tx) => {
      const consumo = await tx.kioskoPairing.updateMany({
        where: { id: pairing.id, estado: KioskoPairingEstado.APROBADO },
        data: { estado: KioskoPairingEstado.RECLAMADO, reclamadoAt: new Date() },
      });
      if (consumo.count !== 1) return false;

      await tx.kiosko.update({
        where: { id: pairing.kiosko!.id },
        data: {
          deviceTokenHash: this.sha256(deviceTokenPlain),
          deviceTokenCreadoAt: new Date(),
        },
      });
      return true;
    });

    if (!resultado) throw new NotFoundException('Solicitud no encontrada');

    this.logger.log(
      `Emparejamiento ${pairing.id} reclamado: kiosko ${pairing.kiosko.id} recibió credencial nueva`,
    );

    return {
      deviceTokenPlain,
      kioskoId: pairing.kiosko.id,
      tiendaId: pairing.kiosko.tiendaId,
      kioskoNombre: pairing.kiosko.nombre,
      tiendaNombre: pairing.kiosko.tienda.nombre,
    };
  }

  /**
   * Purga de solicitudes terminales. Se llama en cada `solicitar()` (barata y sin
   * cron): mantiene la tabla acotada sin agregar infraestructura.
   *
   * Privacidad: las filas RECLAMADO, CANCELADO y EXPIRADO se conservan 30 días
   * tras su terminación — esto cubre cualquier auditoría de "¿alguien
   * vinculó una tablet a este kiosko?" — y luego se purgan. PENDIENTE se
   * purga por TTL directamente (se quedó sin respuesta).
   */
  private static readonly RETENCION_TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;

  async purgarVencidas(): Promise<void> {
    const ahora = new Date();
    const corteExpiradas = new Date(ahora.getTime() - KioskoPairingService.TTL_MS);
    const corteTerminales = new Date(
      ahora.getTime() - KioskoPairingService.RETENCION_TERMINAL_MS,
    );
    await this.prisma.kioskoPairing.deleteMany({
      where: {
        OR: [
          // PENDIENTE que nadie aprobó y ya pasó su TTL.
          {
            createdAt: { lt: corteExpiradas },
            estado: KioskoPairingEstado.PENDIENTE,
          },
          // RECLAMADO / CANCELADO / EXPIRADO: ya no se usan, pero los
          // retenemos 30 días para auditoría antes de borrarlos.
          {
            updatedAt: { lt: corteTerminales },
            estado: {
              in: [
                KioskoPairingEstado.RECLAMADO,
                KioskoPairingEstado.CANCELADO,
                KioskoPairingEstado.EXPIRADO,
              ],
            },
          },
        ],
      },
    });
  }
}
