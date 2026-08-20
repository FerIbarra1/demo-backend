import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Servicio de mapeo polimórfico nube ↔ Firebird.
 *
 * Mantiene la tabla `external_refs` que asocia IDs de la nube (PostgreSQL)
 * con IDs en Firebird local. Un usuario puede ser cliente en varias
 * tiendas: hay un ExternalRef por (usuario, tienda local). Las entidades
 * globales (Corrida, Color, Talla, Linea, Sublinea) tienen localTiendaId
 * = NULL y un único ExternalRef.
 */
@Injectable()
export class ExternalRefService {
  private readonly logger = new Logger(ExternalRefService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Resuelve un ID local de Firebird a partir del ID en la nube.
   * Devuelve null si no hay mapeo (caso normal durante la primera sync).
   */
  async findLocalId(
    systemEntity: string,
    systemId: number,
    localEntity: string,
    localTiendaId?: number | null,
  ): Promise<number | null> {
    const ref = await this.prisma.externalRef.findFirst({
      where: {
        systemEntity,
        systemId,
        localEntity,
        localTiendaId: localTiendaId ?? null,
      },
      select: { localId: true },
    });
    return (ref?.localId as number | null) ?? null;
  }

  /**
   * Resuelve un ID de la nube a partir del ID local de Firebird.
   * Devuelve null si no hay mapeo.
   */
  async findSystemId(
    localEntity: string,
    localId: number,
    localTiendaId?: number | null,
  ): Promise<number | null> {
    const ref = await this.prisma.externalRef.findFirst({
      where: { localEntity, localId, localTiendaId: localTiendaId ?? null },
      select: { systemId: true, systemEntity: true },
    });
    return (ref?.systemId as number | null) ?? null;
  }

  /**
   * Crea o actualiza un mapeo. Usa findFirst + create/update porque
   * Prisma trata el unique compuesto con localTiendaId null como un
   * selector separado (no acepta null en el where del upsert).
   */
  async upsert(args: {
    systemEntity: string;
    systemId: number;
    localEntity: string;
    localId: number;
    localTiendaId?: number | null;
  }): Promise<void> {
    const localTiendaId = args.localTiendaId ?? null;
    const existente = await this.prisma.externalRef.findFirst({
      where: {
        systemEntity: args.systemEntity,
        systemId: args.systemId,
        localEntity: args.localEntity,
        localTiendaId,
      },
      select: { id: true },
    });

    if (existente) {
      await this.prisma.externalRef.update({
        where: { id: existente.id },
        data: { localId: args.localId, syncedAt: new Date() },
      });
    } else {
      await this.prisma.externalRef.create({
        data: {
          systemEntity: args.systemEntity,
          systemId: args.systemId,
          localEntity: args.localEntity,
          localId: args.localId,
          localTiendaId,
        },
      });
    }
  }

  /**
   * Resuelve un set de PrecioCOIds de la nube a IDs locales, dado el
   * `tiendaId` local. Usado por el handler de pedido-descarga cuando
   * el agente baja un pedido nuevo.
   */
  async resolvePrecioCOIds(
    precioCOIdsNube: number[],
    localTiendaId: number,
  ): Promise<Map<number, number>> {
    if (precioCOIdsNube.length === 0) return new Map();
    const refs = await this.prisma.externalRef.findMany({
      where: {
        systemEntity: 'PRECIOCO',
        systemId: { in: precioCOIdsNube },
        localEntity: 'PRECIOSCO',
        localTiendaId,
      },
      select: { systemId: true, localId: true },
    });
    const m = new Map<number, number>();
    refs.forEach((r) => m.set(r.systemId, r.localId));
    return m;
  }
}
