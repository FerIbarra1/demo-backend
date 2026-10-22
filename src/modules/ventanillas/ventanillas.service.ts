import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { EstadoPedido, Prisma, RolUsuario } from '@prisma/client';
import { operadorActivo, ultimaActividad } from '../pedidos/core/estacion.util';

/**
 * Lógica del módulo de ventanillas.
 *
 * Reglas:
 *  - Cada tienda tiene N ventanillas físicas (numeradas 1, 2, 3...).
 *  - Una ventanilla está LIBRE cuando cajeroId = null, OCUPADA cuando no.
 *  - La asignación cajero → ventanilla es 1:1 (cajeroId único en ventanillas).
 *  - El admin puede crear/borrar/renumerar, pero NO borrar una que está
 *    ocupada (debe liberar primero o reasignar).
 *  - El cajero elige su ventanilla al iniciar sesión. El backend libera la
 *    anterior automáticamente si elige una nueva.
 *
 * Realtime: emite `ventanilla.asignada` y `ventanilla.liberada` a
 * `tienda-{tiendaId}` para que la TV refleje cambios en <200ms.
 */
@Injectable()
export class VentanillasService {
  private readonly logger = new Logger(VentanillasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async listarPorTienda(tiendaId: number) {
    const ventanillas = await this.prisma.ventanilla.findMany({
      where: { tiendaId },
      include: {
        cajero: {
          select: {
            id: true,
            nombre: true,
            apellido: true,
            lastLogin: true,
            ultimoHeartbeat: true,
          },
        },
      },
      orderBy: { numero: 'asc' },
    });
    const ahora = new Date();
    // Oct 2026: el selector muestra desde cuándo no da señales el ocupante, para decidir si tomar el
    // control (una ventanilla "ocupada" por alguien que cerró la pestaña no debe bloquear el turno).
    return ventanillas.map(({ cajero, ...v }) => ({
      ...v,
      cajero: cajero ? { id: cajero.id, nombre: cajero.nombre, apellido: cajero.apellido } : null,
      ultimaActividad: ultimaActividad(cajero)?.toISOString() ?? null,
      ocupanteInactivo: cajero ? !operadorActivo(cajero, ahora) : false,
    }));
  }

  /**
   * Crea `cantidad` ventanillas nuevas con numeración correlativa a partir del
   * siguiente número disponible de la tienda. Devuelve las ventanillas creadas.
   */
  async crearN(tiendaId: number, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) {
      throw new BadRequestException('Cantidad debe ser un entero entre 1 y 20');
    }
    const tienda = await this.prisma.tienda.findUnique({ where: { id: tiendaId } });
    if (!tienda) throw new NotFoundException(`Tienda ${tiendaId} no existe`);

    const ultima = await this.prisma.ventanilla.findFirst({
      where: { tiendaId },
      orderBy: { numero: 'desc' },
    });
    const base = ultima?.numero ?? 0;
    const numeros = Array.from({ length: cantidad }, (_, i) => base + i + 1);

    // Verificar que ninguno choque con existentes (por si la BD tiene gaps).
    const choques = await this.prisma.ventanilla.findMany({
      where: { tiendaId, numero: { in: numeros } },
      select: { numero: true },
    });
    if (choques.length > 0) {
      throw new ConflictException(
        `Ya existen ventanillas con número ${choques.map((c) => c.numero).join(', ')}`,
      );
    }

    const creadas = await this.prisma.$transaction(
      numeros.map((numero) =>
        this.prisma.ventanilla.create({
          data: { tiendaId, numero, cajeroId: null, activa: true },
        }),
      ),
    );
    this.logger.log(`Tienda ${tiendaId}: creadas ${creadas.length} ventanillas`);
    return creadas;
  }

  /**
   * Cambia el número de una ventanilla. Valida que el nuevo número no choque
   * con otro de la misma tienda.
   */
  async renumerar(tiendaId: number, id: number, nuevoNumero: number) {
    const v = await this.prisma.ventanilla.findUnique({ where: { id } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${id} no existe en tienda ${tiendaId}`);
    }
    if (!Number.isInteger(nuevoNumero) || nuevoNumero < 1) {
      throw new BadRequestException('Número inválido');
    }
    const choque = await this.prisma.ventanilla.findFirst({
      where: { tiendaId, numero: nuevoNumero, NOT: { id } },
    });
    if (choque) {
      throw new ConflictException(`Ya existe la ventanilla ${nuevoNumero} en esta tienda`);
    }
    const actualizada = await this.prisma.ventanilla.update({
      where: { id },
      data: { numero: nuevoNumero },
    });
    this.logger.log(`Ventanilla ${id}: renumerada ${v.numero} → ${nuevoNumero}`);
    return actualizada;
  }

  /**
   * Borra una ventanilla. Solo si está libre. Si está ocupada por un cajero,
   * tira error para que el admin primero lo desasigne.
   */
  async borrar(tiendaId: number, id: number) {
    const v = await this.prisma.ventanilla.findUnique({ where: { id } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${id} no existe en tienda ${tiendaId}`);
    }
    if (v.cajeroId !== null) {
      throw new ConflictException(
        `La ventanilla ${v.numero} está ocupada por un cajero. Libérala antes de borrarla.`,
      );
    }
    await this.prisma.ventanilla.delete({ where: { id } });
    this.logger.log(`Ventanilla ${id} borrada`);
    return { ok: true };
  }

  /**
   * Cajero elige una ventanilla. Libera la que tuviera antes (si era de su
   * tienda) y le asigna la nueva. Si elige la misma que ya tenía, no hace nada.
   * Emite `ventanilla.asignada` al room `tienda-{id}`.
   *
   * La liberación + asignación se hacen en una transacción para que no queden
   * a medias (si el segundo update falla, el cajero no pierde su ventanilla).
   * La asignación usa updateMany con guarda atómica (cajeroId null o self)
   * para cerrar la race check-then-act entre dos cajeros que eligen la misma
   * ventanilla a la vez.
   */
  async elegir(usuarioId: number, tiendaId: number, ventanillaId: number, forzar = false) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: usuarioId } });
    // F3.5 (oct 2026, "cubrir puesto"): el ADMIN no tiene tienda en su cuenta y cubre la ventanilla de la que
    // OPERA; el resto debe ser de la tienda. Que la ventanilla sea de `tiendaId` se comprueba abajo.
    if (!usuario || (usuario.rol !== RolUsuario.ADMIN && usuario.tiendaId !== tiendaId)) {
      throw new NotFoundException(`Usuario ${usuarioId} no pertenece a tienda ${tiendaId}`);
    }
    if (usuario.rol !== RolUsuario.CAJERO && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Solo cajeros pueden elegir ventanilla');
    }

    const v = await this.prisma.ventanilla.findUnique({ where: { id: ventanillaId } });
    if (!v || v.tiendaId !== tiendaId) {
      throw new NotFoundException(`Ventanilla ${ventanillaId} no existe en tienda ${tiendaId}`);
    }
    if (!v.activa) {
      throw new BadRequestException(`La ventanilla ${v.numero} está inactiva`);
    }

    // Oct 2026: ocupada por OTRA persona. Se puede TOMAR EL CONTROL, pero solo a propósito
    // (`forzar`, con confirmación en la pantalla): el cajero que se fue sin cerrar sesión no debe
    // bloquear la ventanilla, y el que sí está atendiendo no debe perderla por un toque.
    const ocupanteId = v.cajeroId !== null && v.cajeroId !== usuarioId ? v.cajeroId : null;
    if (ocupanteId !== null && !forzar) {
      const o = await this.prisma.usuario.findUnique({
        where: { id: ocupanteId },
        select: { nombre: true, apellido: true },
      });
      throw new ConflictException({
        statusCode: 409,
        code: 'VENTANILLA_OCUPADA',
        message: `La ventanilla ${v.numero} está ocupada por ${o?.nombre ?? 'otro cajero'}. Si ya no está, puedes tomar el control.`,
      });
    }
    let regresados: Array<{ id: number; numeroPedido: string }> = [];
    let anteriorDeOtraTienda: {
      tiendaId: number;
      numero: number;
      id: number;
      regresados: Array<{ id: number; numeroPedido: string }>;
    } | null = null;

    const actualizada = await this.prisma.$transaction(async (tx) => {
      // Liberar la ventanilla anterior del usuario. `cajeroId` es único: quien tenga una en OTRA tienda (el
      // ADMIN que cambió de tienda) debe soltarla antes, o la asignación de abajo violaría esa unicidad.
      const anterior = await tx.ventanilla.findFirst({
        where: { cajeroId: usuarioId, NOT: { id: ventanillaId } },
      });
      if (anterior) {
        await tx.ventanilla.update({
          where: { id: anterior.id },
          data: { cajeroId: null },
        });
        // Cambiar de ventanilla DENTRO de la tienda conserva sus pedidos (siguen siendo suyos). Soltar la de
        // OTRA tienda no: esos pedidos no pueden quedar asignados a alguien que ya no está ahí.
        if (anterior.tiendaId !== tiendaId) {
          anteriorDeOtraTienda = {
            tiendaId: anterior.tiendaId,
            numero: anterior.numero,
            id: anterior.id,
            regresados: await this.regresarPedidosALaFila(
              tx,
              usuarioId,
              anterior.tiendaId,
              anterior.numero,
            ),
          };
        }
      }

      // Si ya era la misma, no-op (idempotente).
      if (v.cajeroId === usuarioId) {
        return v;
      }

      // Tomar el control: quien la tenía deja de tenerla y sus clientes vuelven a la fila.
      if (ocupanteId !== null) {
        regresados = await this.regresarPedidosALaFila(tx, ocupanteId, tiendaId, v.numero);
        const quitada = await tx.ventanilla.updateMany({
          where: { id: ventanillaId, cajeroId: ocupanteId },
          data: { cajeroId: usuarioId },
        });
        if (quitada.count !== 1) {
          throw new ConflictException(
            'La ventanilla cambió mientras la tomabas. Inténtalo de nuevo.',
          );
        }
        return tx.ventanilla.findUnique({
          where: { id: ventanillaId },
          include: { cajero: { select: { id: true, nombre: true, apellido: true } } },
        });
      }

      // Asignación con guarda atómica: solo si la ventanilla está libre o ya
      // es del usuario. Si otro cajero la tomó entre la lectura y aquí, count=0.
      const asignado = await tx.ventanilla.updateMany({
        where: {
          id: ventanillaId,
          OR: [{ cajeroId: null }, { cajeroId: usuarioId }],
        },
        data: { cajeroId: usuarioId },
      });
      if (asignado.count !== 1) {
        throw new ConflictException(`La ventanilla ${v.numero} está ocupada por otro cajero`);
      }

      return tx.ventanilla.findUnique({
        where: { id: ventanillaId },
        include: {
          cajero: { select: { id: true, nombre: true, apellido: true } },
        },
      });
    });

    if (!actualizada) {
      throw new NotFoundException(`Ventanilla ${ventanillaId} no existe en tienda ${tiendaId}`);
    }

    // Emitir realtime fuera de la transacción (no bloquear el commit).
    const previa = anteriorDeOtraTienda as {
      tiendaId: number;
      numero: number;
      id: number;
      regresados: Array<{ id: number; numeroPedido: string }>;
    } | null;
    if (previa) {
      this.realtime.emitToTienda(previa.tiendaId, 'ventanilla.liberada', {
        ventanillaId: previa.id,
        numero: previa.numero,
      });
      this.avisarPedidosRegresados(previa.tiendaId, previa.regresados);
    }
    if (ocupanteId !== null) {
      // Al que la tenía se le avisa: su consola pasa a modo observador.
      this.realtime.emitToUser(ocupanteId, 'ventanilla.perdida', { numero: v.numero });
      this.avisarPedidosRegresados(tiendaId, regresados);
    }
    if (v.cajeroId !== usuarioId) {
      this.realtime.emitToTienda(tiendaId, 'ventanilla.asignada', {
        ventanillaId: actualizada.id,
        numero: actualizada.numero,
        cajeroId: usuario.id,
        cajeroNombre: `${usuario.nombre}${usuario.apellido ? ' ' + usuario.apellido : ''}`,
      });
    }

    this.logger.log(
      `Cajero ${usuarioId} eligió ventanilla ${actualizada.numero} (${actualizada.id}) en tienda ${tiendaId}`,
    );
    return actualizada;
  }

  /**
   * Libera la ventanilla del cajero (logout / cambio de turno).
   * Si no se pasa ventanillaId, libera la que tenga.
   */
  async liberar(usuarioId: number, tiendaId: number, ventanillaId?: number) {
    const where = ventanillaId
      ? { id: ventanillaId, tiendaId, cajeroId: usuarioId }
      : { tiendaId, cajeroId: usuarioId };
    const v = await this.prisma.ventanilla.findFirst({ where });
    if (!v) {
      // No-op: no tenía ventanilla asignada.
      return { ok: true, pedidosRegresadosALaFila: 0 };
    }
    // Oct 2026: los clientes que el cajero tenía en su ventanilla vuelven a la fila.
    //
    // Sin esto, al soltar la ventanilla esos pedidos seguían asignados al cajero (`cajeroAsignadoId`)
    // pero la ventanilla ya no tenía cajero, así que la TV dejaba de mostrarlos (solo lista los de
    // un cajero activo) y la fila tampoco (solo lista los SIN asignar): el cliente que ya estaba
    // siendo atendido desaparecía de toda pantalla. Vuelven CONSERVANDO su lugar
    // (`colaCajaDesdeAt` no se toca): no hicieron nada para perder el turno.
    const regresados = await this.prisma.$transaction(async (tx) => {
      await tx.ventanilla.update({ where: { id: v.id }, data: { cajeroId: null } });
      return this.regresarPedidosALaFila(tx, usuarioId, tiendaId, v.numero);
    });
    this.realtime.emitToTienda(tiendaId, 'ventanilla.liberada', {
      ventanillaId: v.id,
      numero: v.numero,
    });
    this.avisarPedidosRegresados(tiendaId, regresados);
    this.logger.log(
      `Ventanilla ${v.numero} liberada por usuario ${usuarioId}` +
        (regresados.length ? ` (${regresados.length} pedido(s) regresaron a la fila)` : ''),
    );
    return { ok: true, pedidosRegresadosALaFila: regresados.length };
  }

  /**
   * Devuelve a la fila los pedidos que un cajero tenía asignados (`PENDIENTE_PAGO`). Lo usan soltar
   * la ventanilla, tomar el control y el barrido de inactividad: los tres dejan al cajero sin
   * ventanilla y sus clientes no pueden quedarse "asignados" a nadie.
   */
  private async regresarPedidosALaFila(
    tx: Prisma.TransactionClient,
    cajeroId: number,
    tiendaId: number,
    numeroVentanilla: number,
  ) {
    const pendientes = await tx.pedido.findMany({
      where: { cajeroAsignadoId: cajeroId, tiendaId, estado: EstadoPedido.PENDIENTE_PAGO },
      select: { id: true, numeroPedido: true },
    });
    if (pendientes.length === 0) return pendientes;
    await tx.pedido.updateMany({
      where: {
        id: { in: pendientes.map((p) => p.id) },
        estado: EstadoPedido.PENDIENTE_PAGO,
        cajeroAsignadoId: cajeroId,
      },
      data: { cajeroAsignadoId: null, cajeroAsignadoAt: null },
    });
    await tx.historialPedido.createMany({
      data: pendientes.map((p) => ({
        pedidoId: p.id,
        estadoAnterior: EstadoPedido.PENDIENTE_PAGO,
        estadoNuevo: EstadoPedido.PENDIENTE_PAGO,
        observacion: `Regresó a la fila: la ventanilla ${numeroVentanilla} quedó sin cajero con el pedido en espera`,
        usuarioId: cajeroId,
        usuarioNombre: 'Ventanilla',
      })),
    });
    return pendientes;
  }

  private avisarPedidosRegresados(
    tiendaId: number,
    pedidos: Array<{ id: number; numeroPedido: string }>,
  ) {
    for (const p of pedidos) {
      this.realtime.emitToTienda(tiendaId, 'pedido.cajero-liberado', {
        id: p.id,
        numeroPedido: p.numeroPedido,
      });
      this.realtime.emitToPedido(p.id, 'pedido.cajero-liberado', { id: p.id });
    }
  }

  /**
   * Barrido de inactividad: suelta las ventanillas cuyo cajero lleva más de 15 min sin señales
   * (`INACTIVIDAD_ESTACION_MS`) y devuelve a la fila lo que tenían. Sin esto, quien cierra la
   * pestaña sin cerrar sesión deja la ventanilla "ocupada" hasta que alguien la libere a mano.
   */
  async liberarInactivas(ahora: Date = new Date()): Promise<number> {
    const ocupadas = await this.prisma.ventanilla.findMany({
      where: { cajeroId: { not: null } },
      include: { cajero: { select: { lastLogin: true, ultimoHeartbeat: true } } },
    });
    let liberadas = 0;
    for (const v of ocupadas) {
      if (v.cajeroId === null || operadorActivo(v.cajero, ahora)) continue;
      await this.liberar(v.cajeroId, v.tiendaId, v.id);
      liberadas++;
    }
    return liberadas;
  }

  /**
   * Suelta la ventanilla que el usuario tenga en CUALQUIER tienda (y regresa sus pedidos a la fila). Lo usa
   * "soltar mis puestos" del ADMIN al cambiar de tienda o cerrar sesión (F3.5). Null si no tenía ninguna.
   */
  async liberarDelUsuario(usuarioId: number) {
    const v = await this.prisma.ventanilla.findFirst({ where: { cajeroId: usuarioId } });
    if (!v) return null;
    return {
      numero: v.numero,
      tiendaId: v.tiendaId,
      ...(await this.liberar(usuarioId, v.tiendaId, v.id)),
    };
  }

  /** Helper: ventanilla del cajero en una tienda. Null si no tiene. */
  async ventanillaDelCajero(usuarioId: number, tiendaId: number) {
    return this.prisma.ventanilla.findFirst({
      where: { tiendaId, cajeroId: usuarioId },
    });
  }
}
