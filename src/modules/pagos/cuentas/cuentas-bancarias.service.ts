import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { esClabeValida, normalizarClabe } from './clabe.util';
import { ActualizarCuentaBancariaDto, CrearCuentaBancariaDto } from './dto/cuenta-bancaria.dto';
import type { CuentaSnapshot } from '../transferencia/instrucciones.util';

/**
 * Cuentas a las que el cliente transfiere. Las administra ADMIN.
 *
 * Es el dato que un atacante querría cambiar para desviar pagos, así que:
 *   - la CLABE se valida con su dígito de control (un error de dedo manda el dinero a otro lado),
 *   - a lo más UNA cuenta activa por ámbito (índice parcial en la BD),
 *   - cada pago guarda un SNAPSHOT: editar la cuenta no reescribe lo que ya se dijo a clientes
 *     con pagos abiertos,
 *   - toda mutación queda en `log_actividades` (el `AuditLogInterceptor` es global).
 */
@Injectable()
export class CuentasBancariasService {
  private readonly logger = new Logger(CuentasBancariasService.name);

  constructor(private readonly prisma: PrismaService) {}

  listar() {
    return this.prisma.cuentaBancaria.findMany({
      include: { tienda: { select: { id: true, nombre: true } } },
      orderBy: [{ activa: 'desc' }, { tiendaId: 'asc' }, { id: 'desc' }],
    });
  }

  async crear(dto: CrearCuentaBancariaDto) {
    const clabe = this.exigirClabeValida(dto.clabe);
    if (dto.tiendaId != null) await this.exigirTienda(dto.tiendaId);

    return this.enTransaccionDeAmbito(dto.tiendaId ?? null, async (tx) => {
      // La nueva nace ACTIVA: la anterior del mismo ámbito se desactiva en la misma transacción.
      await tx.cuentaBancaria.updateMany({
        where: { tiendaId: dto.tiendaId ?? null, activa: true },
        data: { activa: false },
      });
      return tx.cuentaBancaria.create({
        data: {
          tiendaId: dto.tiendaId ?? null,
          banco: dto.banco,
          titular: dto.titular,
          clabe,
          cuenta: dto.cuenta ?? null,
          instrucciones: dto.instrucciones ?? null,
          activa: true,
        },
      });
    });
  }

  async actualizar(id: number, dto: ActualizarCuentaBancariaDto) {
    const actual = await this.prisma.cuentaBancaria.findUnique({ where: { id } });
    if (!actual) throw new NotFoundException('Cuenta bancaria no encontrada');
    const clabe = dto.clabe !== undefined ? this.exigirClabeValida(dto.clabe) : undefined;

    return this.enTransaccionDeAmbito(actual.tiendaId, async (tx) => {
      if (dto.activa === true) {
        await tx.cuentaBancaria.updateMany({
          where: { tiendaId: actual.tiendaId, activa: true, id: { not: id } },
          data: { activa: false },
        });
      }
      return tx.cuentaBancaria.update({
        where: { id },
        data: {
          banco: dto.banco,
          titular: dto.titular,
          clabe,
          cuenta: dto.cuenta,
          instrucciones: dto.instrucciones,
          activa: dto.activa,
        },
      });
    });
  }

  /**
   * La cuenta con la que se dan las instrucciones de un pedido de `tiendaId`: la de la tienda si
   * tiene una activa, si no la global. Sin ninguna, no se pueden emitir instrucciones.
   */
  async cuentaVigenteParaTienda(tiendaId: number): Promise<CuentaSnapshot & { id: number }> {
    const cuenta =
      (await this.prisma.cuentaBancaria.findFirst({ where: { tiendaId, activa: true } })) ??
      (await this.prisma.cuentaBancaria.findFirst({ where: { tiendaId: null, activa: true } }));
    if (!cuenta) {
      this.logger.error(`Ninguna cuenta bancaria activa para la tienda ${tiendaId}`);
      throw new ConflictException(
        'El pago por transferencia no está configurado todavía. Paga en tienda o inténtalo más tarde.',
      );
    }
    return {
      id: cuenta.id,
      banco: cuenta.banco,
      titular: cuenta.titular,
      clabe: cuenta.clabe,
      cuenta: cuenta.cuenta,
      instrucciones: cuenta.instrucciones,
    };
  }

  /**
   * ¿Hay con qué dar instrucciones en esta tienda? Es la misma búsqueda de `cuentaVigenteParaTienda`
   * (la de la tienda, si no la global) sin lanzar. Las pantallas lo usan para NO ofrecer la
   * transferencia mientras no haya cuenta: antes de que el admin dé de alta la primera, todo
   * cliente la veía y topaba con un 409 al tocarla.
   */
  async hayCuentaVigente(tiendaId: number): Promise<boolean> {
    const cuenta = await this.prisma.cuentaBancaria.findFirst({
      where: { activa: true, OR: [{ tiendaId }, { tiendaId: null }] },
      select: { id: true },
    });
    return cuenta !== null;
  }

  private exigirClabeValida(entrada: string): string {
    if (!esClabeValida(entrada)) {
      throw new BadRequestException(
        'La CLABE no es válida: deben ser 18 dígitos y el último es un dígito de control. Revisa que no falte o sobre ninguno.',
      );
    }
    return normalizarClabe(entrada);
  }

  private async exigirTienda(tiendaId: number) {
    const tienda = await this.prisma.tienda.findUnique({
      where: { id: tiendaId },
      select: { id: true },
    });
    if (!tienda) throw new BadRequestException('La tienda no existe');
  }

  /** Dos admins activando cuentas a la vez chocan con el índice parcial: se traduce a 409. */
  private async enTransaccionDeAmbito<T>(
    _tiendaId: number | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'Otra persona está cambiando la cuenta bancaria al mismo tiempo. Vuelve a intentarlo.',
        );
      }
      throw err;
    }
  }
}
