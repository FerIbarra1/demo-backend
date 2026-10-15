import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EstadoPedido, ModoEntrega, TipoNotificacion } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  ESTADOS_ESPERA_CLIENTE,
  clientePresenteEnTienda,
  wherePresente,
  whereAusente,
} from './presencia.util';
import { umbralesSinRecoger } from './sin-recoger.util';

/** Cuántas veces el cliente puede contestar "sí, lo quiero" antes de que decida el mostrador. */
export const MAX_CONFIRMACIONES_INTERES = 2;

/**
 * F22 (oct 2026): los pedidos apartados que nadie recoge.
 *
 * Una bolsa en el área de entrega es mercancía sacada del anaquel: mientras el
 * cliente no pasa, no se puede vender. El ciclo, con los plazos de
 * `sin-recoger.util.ts`:
 *
 *   1. A las 24 h → correo "¿aún quieres tu pedido?" (una sola vez). El correo
 *      lleva al pedido, donde el cliente puede confirmar que sigue interesado o
 *      cancelarlo él mismo.
 *   2. A las 72 h → el pedido aparece como VENCIDO en la consola de mostrador. El
 *      operador decide: NO se cancela solo. Cancelar tiene consecuencias físicas
 *      (la lista de reposición manda a bodega a regresar la bolsa al anaquel) y
 *      puede que el cliente haya llamado por teléfono.
 *   3. El operador cancela con un motivo y el cliente recibe el correo de
 *      cancelación con ese motivo.
 *
 * Además caduca los avisos de llegada que nadie atendió (ver `barrer`).
 */
@Injectable()
export class SinRecogerService {
  private readonly logger = new Logger(SinRecogerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  umbrales() {
    return umbralesSinRecoger(this.config);
  }

  /**
   * Un barrido: lo corre el worker cada pocos minutos y lo llaman los tests.
   * Idempotente — cada paso reclama su fila con una escritura condicional, así
   * que dos instancias del backend corriendo a la vez no duplican correos.
   */
  async barrer(ahora: Date = new Date()): Promise<{ caducadas: number; recordatorios: number }> {
    const u = this.umbrales();
    const caducadas = await this.caducarPresencias(ahora, u.presenciaCaducaHoras);
    const recordatorios = await this.mandarRecordatorios(ahora, u.recordatorioHoras);
    return { caducadas, recordatorios };
  }

  /**
   * Un aviso de llegada que lleva horas sin que nadie llame al cliente es un
   * fantasma: el cliente avisó y se fue, o es un pedido de kiosko cuyo cliente
   * ya no está. Sin esto la TV de mañana mostraría los folios de hoy.
   *
   * Solo `REVISADO`: un pedido ya llamado (`EN_ATENCION`) lo está atendiendo
   * alguien, y los demás estados no están en la cola.
   *
   * NO cuenta como descarte (`llegadaDescartes`): no fue una falsa alarma, fue
   * tiempo. El cliente que vuelve puede avisar de nuevo sin restricción.
   */
  private async caducarPresencias(ahora: Date, horas: number): Promise<number> {
    const limite = new Date(ahora.getTime() - horas * 3_600_000);
    const candidatos = await this.prisma.pedido.findMany({
      where: {
        estado: EstadoPedido.REVISADO,
        ...wherePresente(),
        presenteDesdeAt: { lt: limite },
      },
      select: { id: true, tiendaId: true },
      take: 200,
    });

    const tiendas = new Set<number>();
    let caducadas = 0;
    for (const p of candidatos) {
      const r = await this.prisma.pedido.updateMany({
        where: { id: p.id, estado: EstadoPedido.REVISADO, llegadaDescartadaAt: null },
        data: { llegadaDescartadaAt: ahora },
      });
      if (r.count !== 1) continue;
      caducadas++;
      tiendas.add(p.tiendaId);
      await this.prisma.historialPedido.create({
        data: {
          pedidoId: p.id,
          estadoAnterior: EstadoPedido.REVISADO,
          estadoNuevo: EstadoPedido.REVISADO,
          observacion: `El aviso de llegada caducó: más de ${horas} h sin que se atendiera al cliente`,
          usuarioNombre: 'Sistema',
        },
      });
    }
    for (const tiendaId of tiendas) {
      this.realtime.emitToTienda(tiendaId, 'monitor.invalidado', { motivo: 'presencia-caducada' });
    }
    if (caducadas > 0) this.logger.log(`${caducadas} aviso(s) de llegada caducaron`);
    return caducadas;
  }

  /** "¿Aún quieres tu pedido?" — una sola vez por ciclo de espera. */
  private async mandarRecordatorios(ahora: Date, horas: number): Promise<number> {
    const limite = new Date(ahora.getTime() - horas * 3_600_000);
    const candidatos = await this.prisma.pedido.findMany({
      where: {
        estado: { in: ESTADOS_ESPERA_CLIENTE },
        // Un pedido a domicilio no se "recoge": su ciclo es otro.
        modoEntrega: { in: [ModoEntrega.RECOGER_TIENDA, ModoEntrega.KIOSKO] },
        esperaClienteDesdeAt: { lt: limite },
        recordatorioRecogerAt: null,
        // Si el cliente está en la tienda, preguntarle si aún lo quiere es absurdo.
        ...whereAusente(),
      },
      orderBy: { esperaClienteDesdeAt: 'asc' },
      take: 100,
    });

    let enviados = 0;
    for (const pedido of candidatos) {
      // Se RECLAMA antes de enviar: si el correo falla se pierde un recordatorio,
      // que es mejor que mandarle al mismo cliente el mismo correo cada barrido.
      const reclamo = await this.prisma.pedido.updateMany({
        where: { id: pedido.id, recordatorioRecogerAt: null },
        data: { recordatorioRecogerAt: ahora },
      });
      if (reclamo.count !== 1) continue;
      enviados++;

      await this.prisma.historialPedido.create({
        data: {
          pedidoId: pedido.id,
          estadoAnterior: pedido.estado,
          estadoNuevo: pedido.estado,
          observacion: `Recordatorio enviado al cliente: lleva más de ${horas} h sin recoger su pedido`,
          usuarioNombre: 'Sistema',
        },
      });
      this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId: pedido.id });
      void this.notifications
        .enviar(pedido, TipoNotificacion.RECORDATORIO_RECOGER)
        .catch((err) =>
          this.logger.error(
            `Pedido ${pedido.id}: no se pudo mandar el recordatorio: ${err.message}`,
          ),
        );
    }
    if (enviados > 0) this.logger.log(`${enviados} recordatorio(s) de "¿aún lo quieres?"`);
    return enviados;
  }

  /**
   * El cliente contesta "sí, lo quiero": reinicia la espera (nuevo plazo y nuevo
   * recordatorio). Tiene tope (`MAX_CONFIRMACIONES_INTERES`): sin él, un cliente
   * podría postergar para siempre una bolsa apartada diciendo "sí" cada tres días
   * sin pasar nunca. Agotado el tope, decide el mostrador.
   */
  async confirmarInteres(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        usuarioId: true,
        tiendaId: true,
        estado: true,
        canalOrigen: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
        interesConfirmadoCount: true,
      },
    });
    if (!pedido || pedido.usuarioId !== usuarioId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (!ESTADOS_ESPERA_CLIENTE.includes(pedido.estado)) {
      throw new BadRequestException('Tu pedido no está esperando que lo recojas.');
    }
    if (clientePresenteEnTienda(pedido)) {
      throw new BadRequestException('Ya avisaste que estás en la tienda: te atenderán pronto.');
    }
    if (pedido.interesConfirmadoCount >= MAX_CONFIRMACIONES_INTERES) {
      throw new BadRequestException(
        'Ya confirmaste que lo querías en dos ocasiones. Pasa por tu pedido o cancélalo; ' +
          'si necesitas más tiempo, llama a la tienda.',
      );
    }

    const r = await this.prisma.pedido.updateMany({
      where: { id: pedidoId, interesConfirmadoCount: pedido.interesConfirmadoCount },
      data: {
        esperaClienteDesdeAt: new Date(),
        recordatorioRecogerAt: null,
        interesConfirmadoCount: { increment: 1 },
      },
    });
    if (r.count !== 1) {
      throw new BadRequestException('Tu respuesta ya se registró. Actualiza la pantalla.');
    }
    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion: 'El cliente confirmó que sigue interesado en su pedido',
        usuarioId,
        usuarioNombre: 'Cliente',
      },
    });
    this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId });
    return { ok: true as const, pedidoId };
  }
}
