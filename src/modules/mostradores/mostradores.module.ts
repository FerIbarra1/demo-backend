import { Module } from '@nestjs/common';
import { MostradoresService } from './mostradores.service';
import { MostradoresAdminController } from './mostradores-admin.controller';
import { MostradoresOperadorController } from './mostradores-operador.controller';
import { PedidosModule } from '../pedidos/pedidos.module';

/**
 * F22 (oct 2026): los mostradores físicos de cada tienda. Espejo de
 * `VentanillasModule`. `RealtimeModule` es @Global, no hace falta importarlo.
 */
@Module({
  // Soltar un mostrador devuelve a la cola a quien tenía llamado: pasa por la máquina de estados.
  imports: [PedidosModule],
  controllers: [MostradoresAdminController, MostradoresOperadorController],
  providers: [MostradoresService],
  exports: [MostradoresService],
})
export class MostradoresModule {}
