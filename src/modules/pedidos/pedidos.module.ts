import { Module } from '@nestjs/common';
import { ClienteController } from './cliente/cliente.controller';
import { ClienteService } from './cliente/cliente.service';
import { BodegaController } from './bodega/bodega.controller';
import { BodegaService } from './bodega/bodega.service';
import { BodegaMonitorController } from './bodega/bodega-monitor.controller';
import { SurtidoService } from './bodega/surtido.service';
import { MonitorService } from './bodega/monitor.service';
import { CajeroController } from './cajero/cajero.controller';
import { CajeroService } from './cajero/cajero.service';
import { CajeroMonitorController } from './cajero/cajero-monitor.controller';
import { CajeroMonitorService } from './cajero/cajero-monitor.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { PropuestaController } from './propuesta/propuesta.controller';
import { PropuestaService } from './propuesta/propuesta.service';
import { VentasController } from './ventas/ventas.controller';
import { VentasService } from './ventas/ventas.service';
import { ReposicionController } from './reposicion/reposicion.controller';
import { ReposicionService } from './reposicion/reposicion.service';
import { PedidoAccessService } from './core/pedido-access.service';
import { PedidoStateService } from './core/pedido-state.service';
import { PedidoBusquedaController } from './core/pedido-busqueda.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { VentanillasModule } from '../ventanillas/ventanillas.module';
import { KioskoModule } from '../kiosko/kiosko.module';

/**
 * Módulo de Pedidos.
 *
 * Estructura por dominio (jul 2026, refactor):
 *   - core/        — piezas compartidas: máquina de estados, access, utils.
 *   - cliente/     — endpoints y service del cliente web.
 *   - bodega/      — endpoints y service de bodega + surtido + monitor bodega.
 *   - cajero/      — endpoints y service de cajero + monitor cajero.
 *   - admin/       — endpoints y service de admin + webhook de pago.
 *   - messages/    — chat cross-rol (cliente, bodega, cajero, admin).
 *
 * Cada subdominio es una carpeta con su controller + service. Todos se
 * registran en este único @Module para mantener un solo punto de DI.
 *
 * Otros módulos consumen los services de `core/`:
 *   - `mostrador/` importa `PedidosModule` y usa
 *     `PedidoStateService.cambiarEstado` y `PedidoAccessService`.
 */
@Module({
  imports: [NotificationsModule, MailModule, VentanillasModule, KioskoModule],
  controllers: [
    ClienteController,
    // IMPORTANTE: BodegaMonitorController (ruta fija `bodega/pedidos/monitor`)
    // va ANTES de BodegaController (ruta genérica `bodega/pedidos/:id`). Si se
    // invierte, NestJS matchea `monitor` contra `@Get(':id')` y el RolesGuard
    // de BodegaController (BODEGA/ADMIN) rechaza a un BODEGA_MONITOR con 403.
    BodegaMonitorController,
    BodegaController,
    // Mismo orden que bodega: CajeroMonitorController (ruta fija `cajero/pedidos/monitor`)
    // va ANTES de CajeroController (ruta genérica `cajero/pedidos/:id`).
    CajeroMonitorController,
    CajeroController,
    AdminController,
    MessagesController,
    PropuestaController,
    VentasController,
    ReposicionController,
    PedidoBusquedaController,
  ],
  providers: [
    ClienteService,
    BodegaService,
    SurtidoService,
    MonitorService,
    CajeroService,
    CajeroMonitorService,
    AdminService,
    MessagesService,
    PropuestaService,
    VentasService,
    ReposicionService,
    PedidoAccessService,
    PedidoStateService,
  ],
  exports: [
    PedidoAccessService,
    PedidoStateService,
    MonitorService,
    SurtidoService,
    AdminService,
    // F13: `mostrador` y otros módulos pueden necesitar consultar reposición.
    ReposicionService,
  ],
})
export class PedidosModule {}
