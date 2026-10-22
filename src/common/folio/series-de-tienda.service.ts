import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Cuánto vive la lista de series en memoria: cambian una vez en la vida de una tienda, pero se leen en cada respuesta. */
export const TTL_SERIES_MS = 60_000;

/**
 * Las iniciales de cada tienda en el Sistema Comercial (`Tienda.serie`: HMO, MXL…), en memoria. Son ocho filas que casi
 * nunca cambian y las necesita cada respuesta que lleva un pedido: se leen de una vez y se refrescan cada minuto (una serie
 * nueva, que llega con el catálogo, se ve en cuanto vence).
 */
@Injectable()
export class SeriesDeTiendaService {
  private series = new Map<number, string | null>();
  private cargadoAt = 0;
  private cargando: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Asegura que la lista esté vigente. Varias respuestas a la vez comparten UNA lectura. */
  async cargar(ahora: number = Date.now()): Promise<void> {
    if (this.cargadoAt && ahora - this.cargadoAt < TTL_SERIES_MS) return;
    if (!this.cargando) {
      this.cargando = this.prisma.tienda
        .findMany({ select: { id: true, serie: true } })
        .then((ts) => {
          this.series = new Map(ts.map((t) => [t.id, t.serie]));
          this.cargadoAt = Date.now();
        })
        .finally(() => {
          this.cargando = null;
        });
    }
    return this.cargando;
  }

  /** La serie de la tienda, o `undefined` si no se conoce (se muestra el folio solo). Síncrona: llamar `cargar()` antes. */
  serieDe(tiendaId: number): string | null | undefined {
    return this.series.get(tiendaId);
  }

  /** Para quien acaba de cambiar una serie y no quiere esperar al TTL. */
  invalidar(): void {
    this.cargadoAt = 0;
  }
}
