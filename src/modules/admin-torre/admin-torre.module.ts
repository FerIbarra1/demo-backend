import { Module } from '@nestjs/common';
import { DtfModule } from '../dtf/dtf.module';
import { GerenciaController } from './gerencia.controller';
import { TorreControlController } from './torre-control.controller';
import { TorreControlService } from './torre-control.service';
import { SaludSistemaController } from './salud-sistema.controller';
import { SaludSistemaService } from './salud-sistema.service';

/**
 * N1 (oct 2026): la torre de control del ADMIN (y, acotada a su tienda, la del GERENTE: `GerenciaController`). Módulo propio y pequeño: junta datos de pedidos, pagos y DTF pero no
 * es de ninguno (importa `DtfModule` solo para `ImpresionService.resumen`, de donde salen los números de DTF).
 * `PrismaModule` es global.
 */
@Module({
  imports: [DtfModule],
  controllers: [TorreControlController, SaludSistemaController, GerenciaController],
  providers: [TorreControlService, SaludSistemaService],
})
export class AdminTorreModule {}
