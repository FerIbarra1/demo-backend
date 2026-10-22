import { EstadoDtf } from '@prisma/client';
import { TrabajoCompleto, vistaTrabajo } from './dtf-vista';

/**
 * La vista de un trabajo DTF depende de QUIÉN mira. Lo que el cliente NO debe ver de Impresión: el nombre del empleado
 * que revisa su trabajo (dato del personal; el historial que lee el cliente ya tiene esa misma regla).
 */
function trabajo(extra: Record<string, unknown> = {}): TrabajoCompleto {
  const ahora = new Date('2026-10-21T12:00:00Z');
  return {
    id: 7,
    pedidoId: null,
    estado: EstadoDtf.EN_REVISION,
    nombre: 'Logo frente',
    notaCliente: null,
    copias: 1,
    tipo: {
      id: 1,
      tecnologia: 'DTF',
      nombre: 'Rollo 57',
      anchoUtilCm: 57,
      minimoCm: 10,
      maxAlturaCm: 250,
      pasoCobroCm: 10,
    },
    anchoCm: null,
    altoCm: null,
    metrosCobrados: null,
    precioMetro: 100,
    subtotal: 0,
    versionVigente: 1,
    archivos: [],
    correccionMotivos: null,
    correccionNota: null,
    rechazoMotivo: null,
    rechazoNota: null,
    aceptoRiesgo: false,
    reimpresiones: 0,
    asignadoAId: 5,
    asignadoA: { id: 5, nombre: 'Marta', apellido: 'Quiroz' },
    createdAt: ahora,
    recibidoAt: ahora,
    aprobadoAt: null,
    imprimiendoAt: null,
    impresoAt: null,
    horaEstimadaAt: null,
    pedido: null,
    ...extra,
  } as unknown as TrabajoCompleto;
}

describe('vistaTrabajo: quién revisa el trabajo', () => {
  it('la consola de Impresión ve quién lo tiene (id y nombre completo)', () => {
    const v = vistaTrabajo(trabajo(), { mira: 'impresion', userId: 9 });
    expect(v.asignadoA).toEqual({ id: 5, nombre: 'Marta Quiroz' });
  });

  it('el CLIENTE no ve el nombre ni el id del empleado, aunque el trabajo esté asignado', () => {
    const v = vistaTrabajo(trabajo(), { mira: 'cliente' });
    expect(v.asignadoA).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/Marta|Quiroz/);
  });

  it('sin empleado asignado, nadie ve nada', () => {
    const t = trabajo({ asignadoAId: null, asignadoA: null });
    expect(vistaTrabajo(t, { mira: 'impresion' }).asignadoA).toBeNull();
    expect(vistaTrabajo(t, { mira: 'cliente' }).asignadoA).toBeNull();
  });

  it('lo que depende de asignadoAId (botones del personal) sigue intacto para el cliente', () => {
    const v = vistaTrabajo(
      trabajo({ estado: EstadoDtf.RECIBIDO, asignadoAId: null, asignadoA: null }),
      {
        mira: 'impresion',
      },
    );
    expect(v.acciones.puedeTomar).toBe(true);
  });
});
