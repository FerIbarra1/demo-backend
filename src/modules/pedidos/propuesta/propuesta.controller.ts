import { Controller, Post, Get, Body, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PropuestaService } from './propuesta.service';
import { ResponderPropuestaDto } from './dto/propuesta.dto';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RolUsuario } from '@prisma/client';

/**
 * F12/F13 (sep 2026): endpoints del flujo de propuesta/contrapropuesta.
 *
 * Oct 2026 — solo quedan los endpoints de RESPUESTA. Los de ENVÍO se eliminaron
 * porque el flujo dejó de pasar por ellos:
 *
 * - Cliente responde:  `POST /cliente/pedidos/:id/propuesta/:propuestaId/respuesta`
 * - Operador responde en nombre del cliente: `POST /mostrador/pedidos/:id/propuesta/:propuestaId/respuesta`
 * - Listar (cualquier rol autorizado): `GET /pedidos/:id/propuestas`
 *
 * La propuesta de bodega la genera el SERVIDOR al cerrar el surtido
 * (`SurtidoService.confirmarSurtido`), y la del asesor viaja como adjunto de un
 * mensaje (`MessagesService.crearConAdjunto`). Ver los comentarios de abajo.
 */
@ApiTags('Pedidos - Propuestas')
@ApiBearerAuth()
@Controller()
export class PropuestaController {
  constructor(private readonly propuestaService: PropuestaService) {}

  // Oct 2026: `POST bodega/pedidos/:id/propuesta` se ELIMINÓ.
  //
  // Desde F17 el bodeguero ya no "envía" propuestas: marca los items del surtido
  // y el servidor arma la propuesta solo (`SurtidoService.confirmarSurtido` →
  // `construirPropuestaDeBodega`). El endpoint no tenía un solo caller en el
  // frontend, y dejarlo era invitar a que alguien lo usara y creara una propuesta
  // fuera del flujo — sin los cambios físicos aplicados ni el mensaje que la
  // acompañaba.
  //
  // `POST ventas/pedidos/:id/propuesta` también se eliminó: el asesor manda su
  // contrapropuesta por `POST pedidos/:id/mensajes/con-adjunto`, que crea el
  // texto y la propuesta en una sola transacción.

  @Post('cliente/pedidos/:id/propuesta/:propuestaId/respuesta')
  @Roles(RolUsuario.CLIENTE, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Cliente responde a una propuesta. Las decisiones legales dependen del origen: ' +
      'propuesta de bodega admite APROBAR/RECHAZAR/CONTACTAR_ASESOR; ' +
      'propuesta de ventas admite APROBAR/RECHAZAR/CANCELAR_PEDIDO.',
  })
  async responderPropuesta(
    @Param('id', ParseIntPipe) id: number,
    @Param('propuestaId', ParseIntPipe) propuestaId: number,
    @Body() dto: ResponderPropuestaDto,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.responderPropuesta(id, propuestaId, dto, user);
  }

  /**
   * Oct 2026: el operador de mostrador responde EN NOMBRE del cliente.
   *
   * El caso: el cliente llega a tienda sin ticket y sin folio, y su pedido está
   * esperando que apruebe una propuesta. Antes se quedaba atorado hasta que el
   * cliente abriera la app — con el cliente enfrente.
   *
   * Reusa `PropuestaService.responderPropuestaDesdeMostrador`, que comparte
   * toda la validación con el camino del cliente. Lo único que cambia es el
   * mapa de decisiones legales: `DECISIONES_POR_ORIGEN[MOSTRADOR]` solo permite
   * APROBAR y RECHAZAR (cancelar tiene su propio flujo con motivo y reposición;
   * mandar a asesor es trabajo de ventas).
   */
  @Post('mostrador/pedidos/:id/propuesta/:propuestaId/respuesta')
  @Roles(RolUsuario.MOSTRADOR, RolUsuario.ADMIN)
  @ApiOperation({
    summary:
      'Oct 2026: el operador de mostrador responde una propuesta en nombre del ' +
      'cliente que tiene enfrente. Solo APROBAR y RECHAZAR.',
  })
  async responderPropuestaDesdeMostrador(
    @Param('id', ParseIntPipe) id: number,
    @Param('propuestaId', ParseIntPipe) propuestaId: number,
    @Body() dto: ResponderPropuestaDto,
    @CurrentUser() user: any,
  ) {
    return this.propuestaService.responderPropuestaDesdeMostrador(id, propuestaId, dto, user);
  }

  // Oct 2026: `POST admin/pedidos/:id/propuesta/:propuestaId/forzar` se eliminó.
  //
  // El service (`PropuestaService.forzarAprobacion`) se conserva: es la válvula
  // de escape para el cliente que nunca responde, y el pedido quedaría atorado
  // sin ella. Lo que se quitó fue el ENDPOINT, que no tenía UI en ninguna consola
  // — nadie podía llamarlo. Si vuelve a hacer falta, se reexpone con su pantalla.

  @Get('pedidos/:id/propuestas')
  // Oct 2026: se agregó MOSTRADOR. El operador necesita VER la propuesta para
  // poder explicársela al cliente que tiene enfrente y responderla en su
  // nombre. Sin este rol, el endpoint le devolvía 403 y el botón "Ver la
  // propuesta" del buscador no llevaba a nada.
  @Roles(
    RolUsuario.BODEGA,
    RolUsuario.VENTAS,
    RolUsuario.ADMIN,
    RolUsuario.CLIENTE,
    RolUsuario.MOSTRADOR,
  )
  @ApiOperation({ summary: 'Lista las propuestas de un pedido (historial).' })
  async listarPropuestas(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.propuestaService.listarPropuestas(id, user);
  }
}
