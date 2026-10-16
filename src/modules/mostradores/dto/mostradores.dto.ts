import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class CrearMostradoresDto {
  @IsInt()
  @Min(1)
  @Max(20)
  cantidad!: number;
}

export class RenumerarMostradorDto {
  @IsInt()
  @Min(1)
  numero!: number;
}

export class ElegirMostradorDto {
  @IsInt()
  mostradorId!: number;

  /** Tomar el control de un mostrador ocupado por otro (la pantalla lo pide con confirmación). */
  @IsOptional()
  @IsBoolean()
  forzar?: boolean;
}

export class LiberarMostradorDto {
  @IsOptional()
  @IsInt()
  mostradorId?: number;
}
