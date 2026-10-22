import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EstadoTareaErp, RolUsuario } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { textoDeTarea } from '../pedidos/core/tareas-erp.util';
import { UserContext } from '../../types/pedido.types';

/**
 * Oct 2026 — la lista de lo que la nube hizo y el Sistema Comercial aún no sabe (ver `core/tareas-erp.util.ts`).
 *
 * La ve y la cierra el CAJERO (es quien opera el Sistema Comercial), el GERENTE de la tienda y el ADMIN. Siempre de UNA
 * tienda: la sale del token (`@TiendaConsola`). "Descartar" (no aplica) lo deciden solo el gerente y el admin, con nota.
 */
@Injectable()
export class TareasErpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Horas desde las que una tarea pendiente cuenta como atrasada (mismo criterio que "verificada sin registrar"). */
  private get horasAtraso(): number {
    return this.config.get<number>('app.pagos.alertaSinRegistrarHoras') ?? 4;
  }

  async listar(tiendaId: number, ahora = new Date()) {
    const filas = await this.prisma.tareaSistemaComercial.findMany({
      where: { tiendaId, estado: EstadoTareaErp.PENDIENTE },
      orderBy: { createdAt: 'asc' },
      include: {
        pedido: {
          select: {
            id: true,
            numeroPedido: true,
            tiendaId: true,
            folioErp: true,
            clienteNombre: true,
          },
        },
      },
      take: 100,
    });
    const data = filas.map((t) => {
      const minutos = Math.max(0, Math.floor((ahora.getTime() - t.createdAt.getTime()) / 60_000));
      return {
        id: t.id,
        tipo: t.tipo,
        ...textoDeTarea(t),
        folio: t.folio,
        motivo: t.motivo,
        creadaPorNombre: t.creadaPorNombre,
        createdAt: t.createdAt,
        minutos,
        atrasada: minutos >= this.horasAtraso * 60,
        pedido: t.pedido,
      };
    });
    return {
      data,
      meta: {
        pendientes: data.length,
        atrasadas: data.filter((t) => t.atrasada).length,
        masViejaMin: data.length ? data[0].minutos : null,
      },
    };
  }

  /** `via`: 'MANUAL' = "ya lo hice en el Sistema Comercial"; 'DESCARTADA' = "no aplica" (con nota). */
  async resolver(
    tareaId: number,
    via: 'MANUAL' | 'DESCARTADA',
    nota: string | undefined,
    user: UserContext,
  ) {
    const tarea = await this.prisma.tareaSistemaComercial.findUnique({ where: { id: tareaId } });
    if (!tarea) throw new NotFoundException('Tarea no encontrada');
    // La tienda sale del token; el ADMIN opera cualquiera.
    if (user.rol !== RolUsuario.ADMIN && tarea.tiendaId !== user.tiendaId) {
      throw new ForbiddenException('Esta tarea es de otra tienda.');
    }
    if (via === 'DESCARTADA') {
      if (user.rol !== RolUsuario.ADMIN && user.rol !== RolUsuario.GERENTE) {
        throw new ForbiddenException(
          'Solo el gerente o el administrador pueden descartar una tarea.',
        );
      }
      if ((nota?.trim().length ?? 0) < 3) {
        throw new BadRequestException('Explica por qué no aplica (mínimo 3 caracteres).');
      }
    }
    // El estado va en el `where`: dos personas cerrando a la vez, una gana y la otra recibe 409.
    const r = await this.prisma.tareaSistemaComercial.updateMany({
      where: { id: tareaId, estado: EstadoTareaErp.PENDIENTE },
      data: {
        estado: via === 'MANUAL' ? EstadoTareaErp.HECHA : EstadoTareaErp.DESCARTADA,
        resueltaAt: new Date(),
        resueltaVia: via,
        resueltaPorId: user.userId,
        resueltaPorNombre: user.nombre,
        notaResolucion: nota?.trim() || null,
      },
    });
    if (r.count !== 1) throw new ConflictException('Esta tarea ya estaba cerrada.');
    return {
      id: tareaId,
      estado: via === 'MANUAL' ? EstadoTareaErp.HECHA : EstadoTareaErp.DESCARTADA,
    };
  }
}
