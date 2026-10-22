import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FolioPedidoInterceptor } from './folio-pedido.interceptor';
import { SeriesDeTiendaService } from './series-de-tienda.service';

/**
 * Global: cualquier servicio que arme un texto con el folio (correos, kiosko, tesorería) pide `SeriesDeTiendaService`
 * sin importar nada, y el interceptor decora toda respuesta HTTP.
 */
@Global()
@Module({
  providers: [
    SeriesDeTiendaService,
    { provide: APP_INTERCEPTOR, useClass: FolioPedidoInterceptor },
  ],
  exports: [SeriesDeTiendaService],
})
export class SeriesModule {}
