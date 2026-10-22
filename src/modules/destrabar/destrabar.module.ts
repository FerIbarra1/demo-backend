import { Module } from '@nestjs/common';
import { PedidosModule } from '../pedidos/pedidos.module';
import { PagosModule } from '../pagos/pagos.module';
import { MostradorModule } from '../mostrador/mostrador.module';
import { DestrabarController, TareasErpController } from './destrabar.controller';
import { DestrabarService } from './destrabar.service';
import { TareasErpService } from './tareas-erp.service';

/**
 * Oct 2026: destrabar pedidos (gerente y admin) y la lista de tareas del Sistema Comercial. Módulo propio: junta
 * `PedidosModule` (cancelar, cobrar a mano, propuestas, liberar), `MostradorModule` (quitar productos) y `PagosModule`
 * (cerrar una transferencia) sin que ninguno de los tres dependa de este. `PrismaModule` es global.
 */
@Module({
  imports: [PedidosModule, PagosModule, MostradorModule],
  controllers: [DestrabarController, TareasErpController],
  providers: [DestrabarService, TareasErpService],
})
export class DestrabarModule {}
