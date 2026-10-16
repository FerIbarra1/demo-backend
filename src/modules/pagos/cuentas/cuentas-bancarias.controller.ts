import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolUsuario } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CuentasBancariasService } from './cuentas-bancarias.service';
import { ActualizarCuentaBancariaDto, CrearCuentaBancariaDto } from './dto/cuenta-bancaria.dto';

@ApiTags('Pagos - Cuentas bancarias (Admin)')
@Controller('admin/cuentas-bancarias')
@Roles(RolUsuario.ADMIN)
@ApiBearerAuth()
export class CuentasBancariasController {
  constructor(private readonly service: CuentasBancariasService) {}

  @Get()
  @ApiOperation({ summary: 'Cuentas bancarias para transferencias (activas e históricas)' })
  listar() {
    return this.service.listar();
  }

  @Post()
  @ApiOperation({
    summary:
      'Da de alta una cuenta (valida la CLABE). Nace activa y desactiva la anterior del mismo ámbito (global o de la tienda).',
  })
  crear(@Body() dto: CrearCuentaBancariaDto) {
    return this.service.crear(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edita una cuenta o la activa/desactiva. Los pagos ya abiertos conservan los datos con los que se emitieron.',
  })
  actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarCuentaBancariaDto) {
    return this.service.actualizar(id, dto);
  }
}
