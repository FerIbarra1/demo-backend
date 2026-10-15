import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EstadoPedido, Prisma, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { KioskoLlegadaService, ReaccionLlegada } from '../../kiosko/kiosko-llegada.service';
import { PedidoStateService } from './pedido-state.service';
import { PedidoAccessService } from './pedido-access.service';
import { clientePresenteEnTienda } from './presencia.util';
import { UserContext } from '../../../types/pedido.types';

/**
 * Cuántas veces se puede llamar a un cliente que no se presenta antes de dar su
 * aviso por perdido. La primera vez pasa al final de la cola; a la segunda se
 * descarta su aviso (y tendrá que volver a avisar).
 */
export const MAX_LLAMADAS_FALLIDAS = 2;

/** El usuario con el que actúa el sistema cuando nadie del personal lo hizo. */
const SISTEMA: UserContext = { userId: 0, nombre: 'Sistema', rol: RolUsuario.ADMIN };

/**
 * F22 (oct 2026): TODO lo que cambia la PRESENCIA del cliente en la tienda y
 * necesita la máquina de estados.
 *
 * Existe porque esas operaciones estaban repartidas y rotas por separado:
 *
 *  - `descartarLlegada` vivía en `MostradorService` y NO movía el estado. Con el
 *    pedido ya llamado (`EN_ATENCION`), descartar su aviso lo dejaba atascado en
 *    un estado que ni la cola ni la TV mostraban (ambas exigen cliente presente):
 *    solo se encontraba con el buscador.
 *  - El kiosko no tenía forma de quitar de la cola al cliente que se fue.
 *  - Un pedido que esperaba aprobación y cuyo cliente llegaba a la tienda era
 *    invisible: el comentario de `destinoTrasSurtidoIncompleto` decía "avisar
 *    llegada lo mueve a REVISADO", pero ese código nunca existió.
 *
 * El aviso en sí (escribir la señal) vive en `KioskoLlegadaService`, que no puede
 * importar `PedidosModule`. Aquí se registra como oyente de ese aviso.
 */
@Injectable()
export class PresenciaService implements OnModuleInit {
  private readonly logger = new Logger(PresenciaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: PedidoStateService,
    private readonly access: PedidoAccessService,
    private readonly realtime: RealtimeService,
    private readonly llegada: KioskoLlegadaService,
  ) {}

  onModuleInit() {
    this.llegada.registrarReaccion((r) => this.alLlegarCliente(r));
  }

  /**
   * El cliente acaba de avisar su llegada. Si su pedido esperaba aprobación de una
   * propuesta, pasa al ÁREA DE ENTREGA para que el operador la resuelva con él
   * enfrente.
   *
   * La propuesta sigue PENDIENTE: lo único que cambia es quién la responde. En
   * `REVISADO` solo la responde el operador (`resolverPropuesta` con
   * `enNombreDelCliente`), que es justo lo que se quiere con el cliente de pie en
   * el mostrador — si pudiera contestarla también desde su teléfono, los dos
   * competirían por una decisión de dinero.
   *
   * Sin correo: decirle "tu pedido ya está listo en tienda" a quien está de pie en
   * el mostrador es ruido (`sinNotificar`).
   */
  async alLlegarCliente(r: ReaccionLlegada): Promise<void> {
    if (r.estado !== EstadoPedido.ESPERANDO_APROBACION) return;

    await this.state.cambiarEstado(
      r.pedidoId,
      {
        nuevoEstado: EstadoPedido.REVISADO,
        observacion:
          `El cliente llegó a la tienda (avisó: ${r.por}) con una propuesta pendiente: ` +
          'pasa al área de entrega para resolverla con él enfrente',
      },
      r.usuario ?? SISTEMA,
      { sinNotificar: true, invalidarMonitor: true },
    );
  }

  /**
   * El mostrador descarta la presencia del cliente: no está (el aviso era falso o
   * ya se fue). Funciona para los DOS canales — un cliente de kiosko también se va.
   *
   * Si el pedido ya estaba llamado (`EN_ATENCION`) vuelve a `REVISADO` en la
   * misma transacción: llamar a alguien que no está no tiene sentido, y dejarlo
   * en `EN_ATENCION` sin presencia es el estado huérfano que ninguna pantalla
   * muestra.
   *
   * Cuenta como DESCARTE (`llegadaDescartes`): a la segunda el botón web del
   * cliente se bloquea. El cliente se entera por realtime.
   */
  async descartar(pedidoId: number, usuario: UserContext) {
    const pedido = await this.cargarParaPresencia(pedidoId, usuario);

    if (!clientePresenteEnTienda(pedido)) {
      throw new BadRequestException(
        'Este pedido no tiene al cliente en la tienda: no hay un aviso de llegada vigente que descartar.',
      );
    }

    const ahora = new Date();
    const data: Prisma.PedidoUpdateInput = {
      llegadaDescartadaAt: ahora,
      llegadaDescartes: { increment: 1 },
      ...(usuario.userId > 0 ? { llegadaDescartadaPor: { connect: { id: usuario.userId } } } : {}),
    };
    const observacion = `Aviso de llegada descartado por ${usuario.nombre} (el cliente no estaba)`;

    await this.aplicarPresencia(pedido, pedidoId, usuario, data, observacion);

    this.realtime.emitToPedido(pedidoId, 'pedido.llegada-descartada', {
      pedidoId,
      numeroPedido: pedido.numeroPedido,
      motivo: 'MOSTRADOR',
    });
    this.logger.log(
      `Pedido ${pedidoId} (${pedido.numeroPedido}): aviso de llegada descartado por ${usuario.nombre}`,
    );
    return { ok: true as const, pedidoId };
  }

  /**
   * El CLIENTE retira su propio aviso ("ya no estoy aquí"): se equivocó de botón o
   * se fue. No cuenta como descarte — no fue una falsa alarma que el mostrador
   * tuvo que corregir, fue el propio cliente corrigiéndose.
   */
  async retirarPorCliente(pedidoId: number, usuarioId: number) {
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        usuarioId: true,
        tiendaId: true,
        numeroPedido: true,
        estado: true,
        canalOrigen: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
      },
    });
    if (!pedido || pedido.usuarioId !== usuarioId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (pedido.estado === EstadoPedido.EN_ATENCION) {
      throw new BadRequestException(
        'Ya te estamos atendiendo en mostrador. Avísale al operador si te vas.',
      );
    }
    if (!clientePresenteEnTienda(pedido)) {
      throw new BadRequestException('No tienes un aviso de llegada vigente que retirar.');
    }

    await this.prisma.pedido.update({
      where: { id: pedidoId },
      data: { llegadaDescartadaAt: new Date(), llegadaDescartadaPorId: null },
    });
    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion: 'El cliente retiró su aviso de llegada (ya no está en la tienda)',
        usuarioId: usuarioId,
        usuarioNombre: 'Cliente',
      },
    });
    this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId });
    return { ok: true as const, pedidoId };
  }

  /**
   * "No se presentó": el operador llamó al cliente y no llegó al mostrador.
   *
   * No es "Devolver a la cola" — esa es para un error del OPERADOR (se equivocó de
   * folio) y conserva el lugar. Esta es para un cliente que sí tenía turno y no lo
   * aprovechó, así que pasa al FINAL de la cola. A la segunda llamada en vano se da
   * su aviso por perdido (se descarta) y tendrá que volver a avisar.
   */
  async noSePresento(pedidoId: number, usuario: UserContext) {
    const pedido = await this.cargarParaPresencia(pedidoId, usuario);
    if (pedido.estado !== EstadoPedido.EN_ATENCION) {
      throw new BadRequestException(
        `Solo se puede marcar "no se presentó" a un pedido ya llamado (actual: ${pedido.estado})`,
      );
    }

    const fallidas = pedido.llamadasFallidas + 1;
    const descartar = fallidas >= MAX_LLAMADAS_FALLIDAS;
    const ahora = new Date();

    const data: Prisma.PedidoUpdateInput = descartar
      ? {
          llamadasFallidas: fallidas,
          llegadaDescartadaAt: ahora,
          llegadaDescartes: { increment: 1 },
          ...(usuario.userId > 0
            ? { llegadaDescartadaPor: { connect: { id: usuario.userId } } }
            : {}),
        }
      : // Pasa al final: su lugar es "ahora", no el de cuando llegó.
        { llamadasFallidas: fallidas, presenteDesdeAt: ahora };

    const observacion = descartar
      ? `No se presentó tras ${fallidas} llamadas (${usuario.nombre}): se descartó su aviso de llegada`
      : `No se presentó al mostrador (${usuario.nombre}): pasa al final de la cola`;

    await this.aplicarPresencia(pedido, pedidoId, usuario, data, observacion);

    if (descartar) {
      this.realtime.emitToPedido(pedidoId, 'pedido.llegada-descartada', {
        pedidoId,
        numeroPedido: pedido.numeroPedido,
        motivo: 'NO_SE_PRESENTO',
      });
    }
    this.logger.log(
      `Pedido ${pedidoId} (${pedido.numeroPedido}): no se presentó (llamada ${fallidas}, descartado=${descartar})`,
    );
    return { ok: true as const, pedidoId, descartado: descartar };
  }

  /**
   * Aplica un cambio de presencia. Si el pedido está llamado, lo regresa a
   * `REVISADO` en la MISMA transacción (el cambio de columnas va en `efectos`, para
   * que no queden a medias: un pedido en `EN_ATENCION` sin presencia es el estado
   * huérfano que ninguna pantalla muestra).
   */
  private async aplicarPresencia(
    pedido: { estado: EstadoPedido; tiendaId: number },
    pedidoId: number,
    usuario: UserContext,
    data: Prisma.PedidoUpdateInput,
    observacion: string,
  ): Promise<void> {
    if (pedido.estado === EstadoPedido.EN_ATENCION) {
      await this.state.cambiarEstado(
        pedidoId,
        { nuevoEstado: EstadoPedido.REVISADO, observacion },
        usuario,
        {
          invalidarMonitor: true,
          // Ya estaba listo en tienda: el correo de "listo" no aplica aquí.
          sinNotificar: true,
          efectos: async (tx) => {
            await tx.pedido.update({ where: { id: pedidoId }, data });
          },
        },
      );
      return;
    }

    await this.prisma.pedido.update({ where: { id: pedidoId }, data });
    await this.prisma.historialPedido.create({
      data: {
        pedidoId,
        estadoAnterior: pedido.estado,
        estadoNuevo: pedido.estado,
        observacion,
        usuarioId: usuario.userId > 0 ? usuario.userId : null,
        usuarioNombre: usuario.nombre,
      },
    });
    // La TV y la consola dejan de mostrarlo.
    this.realtime.emitToTienda(pedido.tiendaId, 'monitor.invalidado', { pedidoId });
  }

  private async cargarParaPresencia(pedidoId: number, usuario: UserContext) {
    await this.access.cargarYValidar(pedidoId, usuario);
    const pedido = await this.prisma.pedido.findUnique({
      where: { id: pedidoId },
      select: {
        id: true,
        tiendaId: true,
        numeroPedido: true,
        estado: true,
        canalOrigen: true,
        llegadaAnunciadaAt: true,
        llegadaDescartadaAt: true,
        llamadasFallidas: true,
      },
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    return pedido;
  }
}
