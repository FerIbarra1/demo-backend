import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PreciosModule } from '../precios/precios.module';
import { PedidosModule } from '../pedidos/pedidos.module';
import { MailModule } from '../mail/mail.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { DtfConfigService } from './dtf-config.service';
import { DtfCorreosService } from './dtf-correos.service';
import { DtfEmisor } from './dtf-emisor.service';
import { DtfPedidoService } from './dtf-pedido.service';
import { DtfTrabajoService } from './dtf-trabajo.service';
import { ImpresionService } from './impresion.service';
import { DtfStorageService } from './storage/dtf-storage.service';
import { PreflightRunner } from './preflight/preflight.runner';
import {
  DtfAdminController,
  DtfClienteController,
  DtfPublicoController,
  ImpresionController,
} from './dtf.controllers';
import { DtfBarridoWorker } from './dtf-barrido.worker';

/** Impresión DTF (oct 2026). Ver PLAN-DTF.md. */
@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    PreciosModule,
    PedidosModule,
    MailModule,
    ConfiguracionModule,
  ],
  controllers: [
    DtfPublicoController,
    DtfClienteController,
    ImpresionController,
    DtfAdminController,
  ],
  providers: [
    DtfConfigService,
    DtfCorreosService,
    DtfEmisor,
    DtfPedidoService,
    DtfTrabajoService,
    ImpresionService,
    DtfStorageService,
    PreflightRunner,
    DtfBarridoWorker,
  ],
  // `ImpresionService`: la torre de control del ADMIN (N1) reutiliza su `resumen` (tabs y metros del día).
  exports: [DtfConfigService, ImpresionService],
})
export class DtfModule {}
