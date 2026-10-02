import { Module } from '@nestjs/common';
import { MostradorService } from './mostrador.service';
import { MostradorController } from './mostrador.controller';
import { MostradorMonitorService } from './mostrador-monitor.service';
import { MostradorMonitorController } from './mostrador-monitor.controller';
import { PedidosModule } from '../pedidos/pedidos.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { KioskoModule } from '../kiosko/kiosko.module';

/**
 * Módulo Mostrador.
 *
 * Depende de PedidosModule para reutilizar:
 *   - PedidoStateService.cambiarEstado (público desde jul 2026) — transición
 *     atómica con historial, realtime y notificación al cliente.
 *   - PedidoAccessService — validación de tienda y rol.
 *   - ReposicionService — la lista de "volver al anaquel" al cancelar.
 *
 * F16 (sep 2026): tiene DOS controllers.
 *   - `MostradorController` (rol MOSTRADOR) — la consola del operador: cola,
 *     llamar, enviar a pagar, ajustar, cancelar, entregar.
 *   - `MostradorMonitorController` (rol MOSTRADOR_MONITOR) — la TV de la pared,
 *     solo lectura.
 *
 * Oct 2026: importa `KioskoModule` para reutilizar
 * `KioskoLlegadaService.confirmarDesdeMostrador` — el operador puede marcar la
 * llegada en nombre del cliente (el que llega sin teléfono o sin folio). La
 * escritura, idempotencia, límite de tasa y realtime del aviso viven en un solo
 * lugar, compartidas con los caminos del kiosko y de la app del cliente.
 *
 * IMPORTANTE — orden de registro: el monitor va ANTES del controller de
 * operador. Ambos viven bajo `pedidos/mostrador`, y la ruta fija `monitor`
 * tiene que matchear antes que los `:id` genéricos, o el RolesGuard rechaza al
 * rol de TV con 403. Es el mismo problema que ya documenta `pedidos.module.ts`
 * para bodega y cajero.
 */
@Module({
  imports: [PedidosModule, RealtimeModule, KioskoModule],
  controllers: [MostradorMonitorController, MostradorController],
  providers: [MostradorService, MostradorMonitorService],
})
export class MostradorModule {}
