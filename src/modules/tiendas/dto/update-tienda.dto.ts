import { PartialType } from '@nestjs/swagger';
import { CreateTiendaDto } from './create-tienda.dto';

export class UpdateTiendaDto extends PartialType(CreateTiendaDto) {}
