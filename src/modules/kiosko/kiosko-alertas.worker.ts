import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { calcularSaludKiosko } from './kiosko-salud';

/**
 * KioskoAlertasWorker: avisa al admin cuando una tablet deja de latir.
 *
 * Sin esto, una tablet caída solo se descubría abriendo el panel y leyendo la
 * lista. Con 50 tiendas eso no escala: el admin necesita enterarse.
 *
 * Diseño deliberado:
 *  - UNA alerta AGREGADA por barrido ("3 kioskos sin conexión"), no un aviso
 *    por tablet. Con muchas tiendas, un toast por kiosko es ruido que hace que
 *    el admin ignore las alertas.
 *  - Solo alerta kioskos con credencial y estado ACTIVO: un kiosko apagado a
 *    propósito no es una falla, y uno sin credencial ya se ve como "requiere
 *    reconexión" en el panel (no necesita un aviso aparte).
 *  - No repite: recuerda a quién ya avisó y solo vuelve a avisar cuando el
 *    kiosko se recupera y se cae de nuevo.
 */
@Injectable()
export class KioskoAlertasWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KioskoAlertasWorker.name);
  private timer?: NodeJS.Timeout;

  /** Cada cuánto se revisa. 5 min: el umbral de caída es 10 min. */
  private static readonly TICK_MS = 5 * 60 * 1000;
  /** Un kiosko más viejo que esto sin latir se considera caído. */
  private static readonly UMBRAL_CAIDA_MS = 10 * 60 * 1000;

  /**
   * Kioskos a los que YA se avisó de su caída. Evita repetir el aviso en cada
   * barrido. Se limpia cuando el kiosko vuelve a latir.
   */
  private yaAvisados = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error(`Kiosko alertas tick falló: ${err.message}`);
      });
    }, KioskoAlertasWorker.TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const ahora = Date.now();

    // Solo kioskos que DEBERÍAN estar latiendo: activos y con credencial.
    const kioskos = await this.prisma.kiosko.findMany({
      where: { estado: 'ACTIVO', deviceTokenHash: { not: null } },
      select: {
        id: true,
        nombre: true,
        estado: true,
        ultimoHeartbeat: true,
        primerConexionAt: true,
        desactivadoAt: true,
        deviceTokenHash: true,
        tienda: { select: { nombre: true } },
      },
    });

    const caidos = kioskos.filter(
      (k) => calcularSaludKiosko(k, ahora) === 'CAIDA',
    );

    // Los que se recuperaron salen de la lista de avisados, para que una caída
    // futura vuelva a alertar.
    const caidosIds = new Set(caidos.map((k) => k.id));
    for (const id of this.yaAvisados) {
      if (!caidosIds.has(id)) this.yaAvisados.delete(id);
    }

    // Solo avisar de los que NO se habían avisado ya.
    const nuevos = caidos.filter((k) => !this.yaAvisados.has(k.id));
    if (nuevos.length === 0) return;

    nuevos.forEach((k) => this.yaAvisados.add(k.id));

    // UNA alerta agregada, no una por tablet.
    this.realtime.emitToRoom('admin:all', 'kiosko.caido', {
      cantidad: nuevos.length,
      kioskos: nuevos.map((k) => ({
        id: k.id,
        nombre: k.nombre,
        tienda: k.tienda.nombre,
        ultimoHeartbeat: k.ultimoHeartbeat,
      })),
    });

    this.logger.warn(
      `${nuevos.length} kiosko(s) sin conexión: ${nuevos.map((k) => `${k.nombre} (${k.tienda.nombre})`).join(', ')}`,
    );
  }
}
