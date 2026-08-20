import { IsNumber, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class ActivarKioskoDto {
  @ApiProperty({ example: 1, description: 'ID de la tienda donde se instala el kiosko' })
  @Type(() => Number)
  @IsNumber()
  tiendaId: number;

  @ApiProperty({
    example: 'Kiosko Entrada',
    description:
      'Nombre del kiosko (único por tienda). El kiosko se crea INACTIVO; ' +
      'se activará al recibir el primer heartbeat desde la tablet en ' +
      '`/kiosko/welcome?tiendaId=X`.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  nombre: string;
}
