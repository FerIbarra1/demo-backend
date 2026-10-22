import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelarPedidoDto } from './cancelar-pedido.dto';

/** El body de cancelar es TODO opcional: el cliente puede cancelar sin decir nada. */
const errores = async (body: object) => validate(plainToInstance(CancelarPedidoDto, body));
const campos = async (body: object) => (await errores(body)).map((e) => e.property);

describe('CancelarPedidoDto', () => {
  it('un body vacío vale: omitir el motivo no es un error', async () => {
    expect(await errores({})).toHaveLength(0);
  });

  it('cada motivo de la lista pasa', async () => {
    for (const motivo of [
      'CAMBIE_DE_OPINION',
      'ME_EQUIVOQUE',
      'TARDO_MUCHO',
      'MEJOR_PRECIO',
      'OTRO',
    ]) {
      expect(await errores({ motivo })).toHaveLength(0);
    }
  });

  it('un motivo que no está en la lista se rechaza', async () => {
    expect(await campos({ motivo: 'PORQUE_SI' })).toContain('motivo');
  });

  it('el texto de «Otro» tiene tope de 200', async () => {
    expect(await errores({ motivo: 'OTRO', detalle: 'x'.repeat(200) })).toHaveLength(0);
    expect(await campos({ motivo: 'OTRO', detalle: 'x'.repeat(201) })).toContain('detalle');
  });

  it('la confirmación de la transferencia es un booleano', async () => {
    expect(await errores({ noHeTransferido: true })).toHaveLength(0);
    expect(await campos({ noHeTransferido: 'sí' })).toContain('noHeTransferido');
  });
});
