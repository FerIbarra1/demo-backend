import { IsInt, IsOptional, Max, Min } from 'class-validator';

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
}

export class LiberarMostradorDto {
  @IsOptional()
  @IsInt()
  mostradorId?: number;
}
