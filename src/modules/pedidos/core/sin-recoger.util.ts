import { ConfigService } from '@nestjs/config';

/**
 * F22 (oct 2026): los plazos de los pedidos apartados que nadie recoge.
 *
 * Todo se cuenta desde `Pedido.esperaClienteDesdeAt` (cuándo la bolsa quedó
 * esperando al cliente). Vive en un util para que el barrido, la consola de
 * mostrador y el cliente lean los MISMOS números: si cada uno calculara su
 * propio "vencido", el operador vería un pedido vencido que el correo del cliente
 * todavía no dio por perdido.
 */
export interface UmbralesSinRecoger {
  /** A estas horas se manda "¿aún quieres tu pedido?". */
  recordatorioHoras: number;
  /** A estas horas el pedido aparece como VENCIDO y el mostrador puede cancelarlo. */
  vencidoHoras: number;
  /** Un aviso de llegada sin atender caduca a estas horas. */
  presenciaCaducaHoras: number;
}

const POR_DEFECTO: UmbralesSinRecoger = {
  recordatorioHoras: 24,
  vencidoHoras: 72,
  presenciaCaducaHoras: 8,
};

export function umbralesSinRecoger(config?: Pick<ConfigService, 'get'>): UmbralesSinRecoger {
  const c = config?.get<Partial<UmbralesSinRecoger>>('app.pedidosSinRecoger') ?? {};
  const positivo = (v: unknown, def: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def;
  const recordatorioHoras = positivo(c.recordatorioHoras, POR_DEFECTO.recordatorioHoras);
  // El vencimiento SIEMPRE va después del recordatorio: el cliente necesita
  // tiempo de contestar entre el aviso y que lo puedan cancelar. Una
  // configuración al revés se corrige en vez de cancelar pedidos sin avisar.
  const vencidoHoras = Math.max(
    positivo(c.vencidoHoras, POR_DEFECTO.vencidoHoras),
    recordatorioHoras + 1,
  );
  return {
    recordatorioHoras,
    vencidoHoras,
    presenciaCaducaHoras: positivo(c.presenciaCaducaHoras, POR_DEFECTO.presenciaCaducaHoras),
  };
}

export interface EstadoEspera {
  /** Horas que lleva la bolsa esperando. */
  horasEsperando: number;
  /** Ya pasó el plazo del recordatorio. */
  recordable: boolean;
  /** Ya pasó el plazo de vencimiento: el mostrador puede cancelarlo. */
  vencido: boolean;
}

export function estadoDeEspera(
  esperaClienteDesdeAt: Date | null,
  umbrales: UmbralesSinRecoger,
  ahora: number = Date.now(),
): EstadoEspera | null {
  if (!esperaClienteDesdeAt) return null;
  const horasEsperando = Math.max(0, (ahora - esperaClienteDesdeAt.getTime()) / 3_600_000);
  return {
    horasEsperando,
    recordable: horasEsperando >= umbrales.recordatorioHoras,
    vencido: horasEsperando >= umbrales.vencidoHoras,
  };
}
