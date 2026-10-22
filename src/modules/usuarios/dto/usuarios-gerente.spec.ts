import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrearUsuarioDto, ROLES_EMPLEADO } from './usuarios.dto';

/**
 * El GERENTE pertenece a UNA tienda (supervisa SU tienda): sin `tiendaId` no hay nada que acotar, así que el alta
 * lo exige igual que a cualquier empleado. La única excepción a "todo empleado lleva tienda" es Tesorería.
 */
const base = {
  email: 'gerente@tienda.com',
  nombre: 'Gerente',
  password: '123456',
  rol: 'GERENTE',
};
const errores = async (body: object) => validate(plainToInstance(CrearUsuarioDto, body));

describe('Alta de un GERENTE', () => {
  it('el ADMIN puede asignar el rol (está entre los roles de empleado)', () => {
    expect(ROLES_EMPLEADO).toContain('GERENTE');
  });

  it('sin tienda se rechaza', async () => {
    const e = await errores(base);
    expect(e.map((x) => x.property)).toContain('tiendaId');
  });

  it('con tienda pasa', async () => {
    expect(await errores({ ...base, tiendaId: 2 })).toHaveLength(0);
  });

  it('Tesorería sigue siendo la única que no la lleva', async () => {
    expect(await errores({ ...base, rol: 'TESORERIA' })).toHaveLength(0);
  });
});
