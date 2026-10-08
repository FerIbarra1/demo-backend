import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO del endpoint de subida.
 *
 * El campo `file` está aquí SOLO para que `whitelist:true +
 * forbidNonWhitelisted:true` no rechace el multipart: cuando multer parsea
 * el `multipart/form-data`, además de poblar `req.file` deja el campo
 * `file` también en `req.body`. Si el DTO no lo declara, el ValidationPipe
 * lo ve como propiedad desconocida y aborta con
 * `"property file should not exist"`.
 *
 * El archivo binario real se recibe vía `@UploadedFile()` en el controller
 * (extraído por `FileInterceptor`), no por este DTO. Esta propiedad nunca se
 * valida ni se usa — solo existe para satisfacer la whitelist.
 *
 * `colorId` es obligatorio: ya no existe el bucket "general" (colorId NULL).
 */
export class SubirImagenDto {
  @ApiProperty({
    description: 'ID del color al que pertenece la imagen. Obligatorio.',
    example: 3,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  colorId!: number;

  /**
   * Multer popula este campo en `req.body` al parsear multipart. La validación
   * y el procesamiento del archivo real ocurre vía `@UploadedFile()`.
   */
  @IsOptional()
  file?: unknown;
}