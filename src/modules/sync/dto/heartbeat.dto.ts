import { IsString, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class HeartbeatDto {
  @ApiProperty({ example: '1.0.0', description: 'Versión del agente (semver)' })
  @IsString()
  @MaxLength(20)
  agentVersion: string;

  @ApiProperty({ example: 'TIENDA5-PC01', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  hostname?: string;
}
