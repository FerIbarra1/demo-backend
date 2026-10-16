import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarcarPagadoDto } from './marcar-pagado.dto';

const errores = async (plano: object) =>
  (await validate(plainToInstance(MarcarPagadoDto, plano), { whitelist: true })).map(
    (e) => e.property,
  );

describe('MarcarPagadoDto', () => {
  it('acepta el body vacío y los dos campos válidos', async () => {
    expect(await errores({})).toEqual([]);
    expect(
      await errores({ fechaPago: '2026-10-15T18:30:00.000Z', referencia: 'FIREBIRD-12345' }),
    ).toEqual([]);
  });

  it('rechaza una fecha que no es fecha', async () => {
    expect(await errores({ fechaPago: 'mañana' })).toEqual(['fechaPago']);
  });

  it('rechaza una referencia de más de 120 caracteres o que no es texto', async () => {
    expect(await errores({ referencia: 'x'.repeat(121) })).toEqual(['referencia']);
    expect(await errores({ referencia: 12345 })).toEqual(['referencia']);
  });
});
