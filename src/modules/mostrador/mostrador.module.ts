import { Module } from '@nestjs/common';
import { MostradorService } from './mostrador.service';
import { MostradorController } from './mostrador.controller';
import { PedidosModule } from '../pedidos/pedidos.module';

/**
 * Módulo Mostrador.
 *
 * Depende de PedidosModule para reutilizar:
 *   - PedidosService.cambiarEstado (público desde jul 2026) — transición
 *     atómica con historial, realtime y notificación al cliente.
 *   - PedidoAccessService — validación de tienda y rol.
 *
 * No duplica esa lógica: si en el futuro cambia la máquina de estados
 * (notificaciones, side-effects, etc.), el cambio se hace en un solo
 * lugar y mostrador lo hereda gratis.
 */
@Module({
  imports: [PedidosModule],
  controllers: [MostradorController],
  providers: [MostradorService],
})
export class MostradorModule {}
