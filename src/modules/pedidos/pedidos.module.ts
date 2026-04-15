import { Module } from '@nestjs/common';
import { PedidosService } from './pedidos.service';
import { PedidosClienteController } from './pedidos-cliente.controller';
import { PedidosBodegaController } from './pedidos-bodega.controller';
import { PedidosCajeroController } from './pedidos-cajero.controller';
import { PedidosMostradorController } from './pedidos-mostrador.controller';
import { PedidosAdminController } from './pedidos-admin.controller';

@Module({
  controllers: [
    PedidosClienteController,
    PedidosBodegaController,
    PedidosCajeroController,
    PedidosMostradorController,
    PedidosAdminController,
  ],
  providers: [PedidosService],
  exports: [PedidosService],
})
export class PedidosModule {}
