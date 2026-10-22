import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiTiendaConsola, TiendaConsola, TiendaConsolaGuard } from '../../common/tienda-consola';
import { TorreControlService } from './torre-control.service';
import { SaludSistemaService } from './salud-sistema.service';

/**
 * Oct 2026: lo que ve el GERENTE de UNA tienda. Controller APARTE de `admin/torre-control` y `admin/salud` (que son
 * `@Roles(ADMIN)` de clase) por la misma razón que la búsqueda global: abrirle esas rutas a otro rol con un
 * `@Roles` más haría que quitarlo por descuido dejara la vista de TODAS las tiendas a la vista de un gerente.
 *
 * La tienda sale del token (`@TiendaConsola`): un `?tiendaId=` de un gerente se IGNORA, así que no hay forma de
 * mirar otra tienda. El ADMIN pasa `RolesGuard` siempre, pero aquí también tiene que elegir una tienda.
 *
 * Solo LECTURA. Las acciones para destrabar pedidos son otra pieza y llevan su propia bitácora.
 */
@ApiTags('Gerencia')
@UseGuards(TiendaConsolaGuard)
@Controller('gerencia')
@Roles(RolUsuario.GERENTE)
@ApiBearerAuth()
export class GerenciaController {
  constructor(
    private readonly torre: TorreControlService,
    private readonly salud: SaludSistemaService,
  ) {}

  @Get('torre-control')
  @ApiTiendaConsola()
  @ApiOperation({
    summary:
      'Gerente: cómo va SU tienda (pedidos por etapa, la espera más larga, transferencias, DTF y semáforo).',
  })
  torreControl(@CurrentUser() user: any, @TiendaConsola() tienda: number) {
    return this.torre.obtener(user, new Date(), tienda);
  }

  @Get('salud')
  @ApiTiendaConsola()
  @ApiOperation({
    summary:
      'Gerente: salud de SU tienda (agente y bandeja al Sistema Comercial, kioskos, TV de bodega), sin errores técnicos del ERP.',
  })
  saludDeLaTienda(@TiendaConsola() tienda: number) {
    return this.salud.obtenerParaGerente(tienda);
  }
}
