import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GRUPOS_PAGO, VencerPagoDto } from './pago.dto';

// Sin plazo que lo justifique, "marcar vencida" es una decisión de una persona: el motivo no es opcional.
const errores = async (body: object) => validate(plainToInstance(VencerPagoDto, body));

describe('VencerPagoDto', () => {
  it('exige el motivo', async () => {
    expect(await errores({})).not.toHaveLength(0);
  });

  it('rechaza un motivo de menos de 3 caracteres (también con espacios de relleno)', async () => {
    expect(await errores({ motivo: 'ab' })).not.toHaveLength(0);
    expect(await errores({ motivo: '   a   ' })).not.toHaveLength(0);
  });

  it('acepta un motivo real', async () => {
    expect(await errores({ motivo: 'El cliente ya no va a transferir' })).toHaveLength(0);
  });

  it('ya no existe el grupo "vencidas": no hay plazo que lo defina', () => {
    expect(GRUPOS_PAGO).not.toContain('vencidas');
  });
});
