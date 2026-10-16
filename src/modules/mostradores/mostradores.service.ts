import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EstadoPedido, RolUsuario } from '@prisma/client';
import { PedidoStateService } from '../pedidos/core/pedido-state.service';
import { operadorActivo, ultimaActividad } from '../pedidos/core/estacion.util';
import { UserContext } from '../../types/pedido.types';

/** El usuario con el que actúa el sistema cuando nadie del personal lo hizo. */
const SISTEMA: UserContext = { userId: 0, nombre: 'Sistema', rol: RolUsuario.ADMIN };
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * F22 (oct 2026): los mostradores físicos de la tienda — el equivalente de
 * `VentanillasService` para el operador de mostrador.
 *
 * Reglas (las mismas que las ventanillas del cajero, a propósito: el negocio ya
 * entiende ese modelo y el admin lo configura igual):
 *  - Cada tienda tiene N mostradores numerados (1, 2, 3...). El admin los crea,
 *    renumera y borra desde el panel de tiendas.
 *  - Un mostrador está LIBRE cuando `operadorId = null`, OCUPADO cuando no.
 *  - La asignación operador → mostrador es 1:1. El operador elige el suyo al
 *    entrar; el backend libera el anterior si elige otro.
 *  - No se borra un mostrador ocupado.
 *
 * Cuando el operador llama a un cliente, la TV dice "Pasa al mostrador N". Por
 * eso `llamar` exige tener mostrador elegido — salvo que la tienda no tenga
 * ninguno configurado (una tienda con una sola mesa no necesita decirle al
 * cliente a cuál ir; ver `resolverParaLlamar`).
 *
 * Realtime: `mostrador.asignado` y `mostrador.liberado` a `tienda-{id}`.
 */
@Injectable()
export class MostradoresService {
  private readonly logger = new Logger(MostradoresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly state: PedidoStateService,
  ) {}

  async listarPorTienda(tiendaId: number) {
    const mostradores = await this.prisma.mostrador.findMany({
      where: { tiendaId },
      include: {
        operador: {
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
    // El selector muestra desde cuándo no da señales el ocupante (ver `VentanillasService`).
    return mostradores.map(({ operador, ...m }) => ({
      ...m,
      operador: operador
        ? { id: operador.id, nombre: operador.nombre, apellido: operador.apellido }
        : null,
      ultimaActividad: ultimaActividad(operador)?.toISOString() ?? null,
      ocupanteInactivo: operador ? !operadorActivo(operador, ahora) : false,
    }));
  }

  /**
   * Crea `cantidad` mostradores con numeración correlativa a partir del
   * siguiente número disponible de la tienda.
   */
  async crearN(tiendaId: number, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) {
      throw new BadRequestException('Cantidad debe ser un entero entre 1 y 20');
    }
    const tienda = await this.prisma.tienda.findUnique({ where: { id: tiendaId } });
    if (!tienda) throw new NotFoundException(`Tienda ${tiendaId} no existe`);

    const ultimo = await this.prisma.mostrador.findFirst({
      where: { tiendaId },
      orderBy: { numero: 'desc' },
    });
    const base = ultimo?.numero ?? 0;
    const numeros = Array.from({ length: cantidad }, (_, i) => base + i + 1);

    const choques = await this.prisma.mostrador.findMany({
      where: { tiendaId, numero: { in: numeros } },
      select: { numero: true },
    });
    if (choques.length > 0) {
      throw new ConflictException(
        `Ya existen mostradores con número ${choques.map((c) => c.numero).join(', ')}`,
      );
    }

    const creados = await this.prisma.$transaction(
      numeros.map((numero) =>
        this.prisma.mostrador.create({
          data: { tiendaId, numero, operadorId: null, activa: true },
        }),
      ),
    );
    this.logger.log(`Tienda ${tiendaId}: creados ${creados.length} mostradores`);
    return creados;
  }

  async renumerar(tiendaId: number, id: number, nuevoNumero: number) {
    const m = await this.prisma.mostrador.findUnique({ where: { id } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${id} no existe en tienda ${tiendaId}`);
    }
    if (!Number.isInteger(nuevoNumero) || nuevoNumero < 1) {
      throw new BadRequestException('Número inválido');
    }
    const choque = await this.prisma.mostrador.findFirst({
      where: { tiendaId, numero: nuevoNumero, NOT: { id } },
    });
    if (choque) {
      throw new ConflictException(`Ya existe el mostrador ${nuevoNumero} en esta tienda`);
    }
    const actualizado = await this.prisma.mostrador.update({
      where: { id },
      data: { numero: nuevoNumero },
    });
    this.logger.log(`Mostrador ${id}: renumerado ${m.numero} → ${nuevoNumero}`);
    return actualizado;
  }

  /** Borra un mostrador libre. Si hay un operador ahí, tira error. */
  async borrar(tiendaId: number, id: number) {
    const m = await this.prisma.mostrador.findUnique({ where: { id } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${id} no existe en tienda ${tiendaId}`);
    }
    if (m.operadorId !== null) {
      throw new ConflictException(
        `El mostrador ${m.numero} está ocupado por un operador. Libéralo antes de borrarlo.`,
      );
    }
    await this.prisma.mostrador.delete({ where: { id } });
    this.logger.log(`Mostrador ${id} borrado`);
    return { ok: true };
  }

  /**
   * El operador elige un mostrador. Libera el que tuviera antes y le asigna el
   * nuevo en una sola transacción; la asignación usa `updateMany` con guarda
   * atómica (libre o ya suyo) para cerrar la carrera entre dos operadores que
   * eligen el mismo a la vez. Idempotente si ya era el suyo.
   */
  async elegir(usuarioId: number, tiendaId: number, mostradorId: number, forzar = false) {
    const usuario = await this.prisma.usuario.findUnique({ where: { id: usuarioId } });
    if (!usuario || usuario.tiendaId !== tiendaId) {
      throw new NotFoundException(`Usuario ${usuarioId} no pertenece a tienda ${tiendaId}`);
    }
    if (usuario.rol !== RolUsuario.MOSTRADOR && usuario.rol !== RolUsuario.ADMIN) {
      throw new BadRequestException('Solo operadores de mostrador pueden elegir mostrador');
    }

    const m = await this.prisma.mostrador.findUnique({ where: { id: mostradorId } });
    if (!m || m.tiendaId !== tiendaId) {
      throw new NotFoundException(`Mostrador ${mostradorId} no existe en tienda ${tiendaId}`);
    }
    if (!m.activa) {
      throw new BadRequestException(`El mostrador ${m.numero} está inactivo`);
    }

    // Ocupado por OTRO operador: solo se toma el control a propósito (`forzar`, con confirmación).
    const ocupanteId = m.operadorId !== null && m.operadorId !== usuarioId ? m.operadorId : null;
    if (ocupanteId !== null && !forzar) {
      const o = await this.prisma.usuario.findUnique({
        where: { id: ocupanteId },
        select: { nombre: true },
      });
      throw new ConflictException({
        statusCode: 409,
        code: 'MOSTRADOR_OCUPADO',
        message: `El mostrador ${m.numero} está ocupado por ${o?.nombre ?? 'otro operador'}. Si ya no está, puedes tomar el control.`,
      });
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const anterior = await tx.mostrador.findFirst({
        where: { tiendaId, operadorId: usuarioId, NOT: { id: mostradorId } },
      });
      if (anterior) {
        await tx.mostrador.update({ where: { id: anterior.id }, data: { operadorId: null } });
      }

      if (m.operadorId === usuarioId) return m;

      const asignado = await tx.mostrador.updateMany({
        where: {
          id: mostradorId,
          // Libre, ya suyo, o —con `forzar`— del ocupante que se vio al principio.
          OR: [
            { operadorId: null },
            { operadorId: usuarioId },
            ...(ocupanteId !== null ? [{ operadorId: ocupanteId }] : []),
          ],
        },
        data: { operadorId: usuarioId },
      });
      if (asignado.count !== 1) {
        throw new ConflictException(`El mostrador ${m.numero} está ocupado por otro operador`);
      }

      return tx.mostrador.findUnique({
        where: { id: mostradorId },
        include: { operador: { select: { id: true, nombre: true, apellido: true } } },
      });
    });

    if (!actualizado) {
      throw new NotFoundException(`Mostrador ${mostradorId} no existe en tienda ${tiendaId}`);
    }

    if (ocupanteId !== null) {
      // Al que lo tenía se le avisa (su consola pasa a observador) y su cliente llamado vuelve a la cola.
      this.realtime.emitToUser(ocupanteId, 'mostrador.perdido', { numero: m.numero });
      await this.regresarLlamados(m.id);
    }
    if (m.operadorId !== usuarioId) {
      this.realtime.emitToTienda(tiendaId, 'mostrador.asignado', {
        mostradorId: actualizado.id,
        numero: actualizado.numero,
        operadorId: usuario.id,
        operadorNombre: `${usuario.nombre}${usuario.apellido ? ' ' + usuario.apellido : ''}`,
      });
    }

    this.logger.log(
      `Operador ${usuarioId} eligió mostrador ${actualizado.numero} (${actualizado.id}) en tienda ${tiendaId}`,
    );
    return actualizado;
  }

  /** Libera el mostrador del operador (cierre de sesión / cambio de turno). */
  async liberar(usuarioId: number, tiendaId: number, mostradorId?: number) {
    const where = mostradorId
      ? { id: mostradorId, tiendaId, operadorId: usuarioId }
      : { tiendaId, operadorId: usuarioId };
    const m = await this.prisma.mostrador.findFirst({ where });
    if (!m) return { ok: true, clientesRegresadosALaCola: 0 };
    await this.prisma.mostrador.update({ where: { id: m.id }, data: { operadorId: null } });
    const regresados = await this.regresarLlamados(m.id);
    this.realtime.emitToTienda(tiendaId, 'mostrador.liberado', {
      mostradorId: m.id,
      numero: m.numero,
    });
    this.logger.log(`Mostrador ${m.numero} liberado por usuario ${usuarioId}`);
    return { ok: true, clientesRegresadosALaCola: regresados };
  }

  /**
   * Oct 2026: los clientes que el operador tenía LLAMADOS desde este mostrador (`EN_ATENCION`) vuelven
   * a la cola (`REVISADO`) conservando su lugar. Sin esto, soltar el mostrador dejaba el folio
   * anunciado en la TV —"Pasa al mostrador 2"— frente a un mostrador sin nadie. Pasa por la máquina de
   * estados (nunca se escribe `estado` a mano); `presenteDesdeAt` no se toca, así que no pierden turno.
   */
  private async regresarLlamados(mostradorId: number): Promise<number> {
    const llamados = await this.prisma.pedido.findMany({
      where: { estado: EstadoPedido.EN_ATENCION, llamadoMostradorId: mostradorId },
      select: { id: true },
    });
    let n = 0;
    for (const p of llamados) {
      try {
        await this.state.cambiarEstado(
          p.id,
          {
            nuevoEstado: EstadoPedido.REVISADO,
            observacion:
              'Devuelto a la cola: el mostrador quedó sin operador con el cliente llamado',
          },
          SISTEMA,
          { invalidarMonitor: true, sinNotificar: true },
        );
        n++;
      } catch (err) {
        // Otro movimiento lo alcanzó (ya lo cobró, lo canceló…): no hay nada que devolver.
        this.logger.warn(
          `Pedido ${p.id}: no se pudo devolver a la cola (${(err as Error).message})`,
        );
      }
    }
    return n;
  }

  /** Barrido de inactividad: suelta los mostradores cuyo operador lleva +15 min sin señales. */
  async liberarInactivos(ahora: Date = new Date()): Promise<number> {
    const ocupados = await this.prisma.mostrador.findMany({
      where: { operadorId: { not: null } },
      include: { operador: { select: { lastLogin: true, ultimoHeartbeat: true } } },
    });
    let liberados = 0;
    for (const m of ocupados) {
      if (m.operadorId === null || operadorActivo(m.operador, ahora)) continue;
      await this.liberar(m.operadorId, m.tiendaId, m.id);
      liberados++;
    }
    return liberados;
  }

  /** El mostrador donde trabaja el operador (null si no eligió). */
  async delOperador(usuarioId: number, tiendaId: number) {
    return this.prisma.mostrador.findFirst({ where: { tiendaId, operadorId: usuarioId } });
  }

  /**
   * Lo mismo, más CUÁNTOS clientes tiene llamados desde él (`EN_ATENCION`). La consola lo usa para
   * avisar al soltar el mostrador —"N clientes regresarán a la cola"— sin adivinarlo con la página
   * de la lista que tenga cargada: soltarlo los regresa a todos (`regresarLlamados`).
   */
  async delOperadorConCarga(usuarioId: number, tiendaId: number) {
    const m = await this.delOperador(usuarioId, tiendaId);
    if (!m) return null;
    const clientesEnCurso = await this.prisma.pedido.count({
      where: { estado: EstadoPedido.EN_ATENCION, llamadoMostradorId: m.id },
    });
    return { ...m, clientesEnCurso };
  }

  /**
   * El mostrador desde el que el operador llama a un cliente.
   *
   * Oct 2026: YA NO HAY modo genérico. Antes, una tienda sin mostradores configurados llamaba "sin
   * número" y el operador sin mostrador podía operar todo; ahora el mostrador es la estación que
   * autoriza a atender (igual que la ventanilla del cajero): sin él solo se mira. El ADMIN queda
   * exento (`esAdmin`) y llama sin número si no tiene mostrador.
   */
  async resolverParaLlamar(usuarioId: number, tiendaId: number, esAdmin = false) {
    const mio = await this.delOperador(usuarioId, tiendaId);
    if (mio) return mio;
    if (esAdmin) return null;
    const configurados = await this.prisma.mostrador.count({ where: { tiendaId, activa: true } });
    throw new BadRequestException(
      configurados > 0
        ? 'Elige tu mostrador antes de llamar a un cliente: la pantalla le dirá a cuál pasar.'
        : 'Esta tienda no tiene mostradores configurados: pide al admin que los cree.',
    );
  }
}
