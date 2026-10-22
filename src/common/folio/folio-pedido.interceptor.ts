import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, mergeMap } from 'rxjs';
import { decorarConFolio } from './folio-decorador';
import { SeriesDeTiendaService } from './series-de-tienda.service';

/**
 * Agrega `folio` a todo pedido de toda respuesta HTTP (ver `folio-decorador.ts`). Global: el ID de un pedido se arma en un
 * solo sitio y ningún endpoint nuevo puede olvidarlo. Si no se pueden leer las series el folio sale sin prefijo: el
 * interceptor nunca tumba una respuesta por esto.
 */
@Injectable()
export class FolioPedidoInterceptor implements NestInterceptor {
  private readonly logger = new Logger(FolioPedidoInterceptor.name);

  constructor(private readonly series: SeriesDeTiendaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    return next.handle().pipe(
      mergeMap(async (data: unknown) => {
        if (data === null || typeof data !== 'object') return data;
        try {
          await this.series.cargar();
        } catch (err) {
          this.logger.warn(`No se pudieron leer las series de tienda: ${(err as Error).message}`);
        }
        decorarConFolio(data, (id) => this.series.serieDe(id));
        return data;
      }),
    );
  }
}
