import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIERE_ESTACION } from './estacion.guard';
import { CajeroController } from '../../modules/pedidos/cajero/cajero.controller';
import { MostradorController } from '../../modules/mostrador/mostrador.controller';
import { PagoTiendaController } from '../../modules/pagos/transferencia/pago-tienda.controller';

/**
 * "Sin estación solo se MIRA" vive en el servidor: toda ruta que CAMBIA algo desde caja, mostrador o
 * la forma de pago de la tienda lleva `@RequiereEstacion()`. Sin esta prueba, la siguiente ruta
 * POST que alguien agregue (el comprobante que sube la cajera, "regresar a la cola hasta que se
 * valide"…) nacería abierta, y un observador —o una pantalla desfasada— podría usarla.
 *
 * Es un cierre por construcción, no por memoria: una ruta de escritura nueva sin la marca rompe
 * aquí. Las lecturas (GET) no la llevan a propósito.
 */
const CONTROLADORES = [CajeroController, MostradorController, PagoTiendaController];

function rutasPost(controlador: { prototype: object }) {
  const proto = controlador.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    .map((n) => ({ nombre: n, handler: proto[n] as object }))
    .filter(({ handler }) => Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.POST)
    .map(({ nombre, handler }) => ({
      nombre,
      ruta: String(Reflect.getMetadata(PATH_METADATA, handler)),
      exige: Reflect.getMetadata(REQUIERE_ESTACION, handler) === true,
    }));
}

describe('rutas de escritura de caja y mostrador exigen estación', () => {
  it.each(CONTROLADORES.map((c) => [c.name, c] as const))(
    '%s: todo POST lleva @RequiereEstacion()',
    (_nombre, controlador) => {
      const rutas = rutasPost(controlador);
      expect(rutas.length).toBeGreaterThan(0); // la prueba no puede pasar vacía
      expect(rutas.filter((r) => !r.exige).map((r) => `${r.nombre} (${r.ruta})`)).toEqual([]);
    },
  );

  it('las rutas nuevas de este cambio están cubiertas', () => {
    const nombres = [...CONTROLADORES].flatMap((c) => rutasPost(c).map((r) => r.nombre));
    expect(nombres).toEqual(
      expect.arrayContaining([
        'esperarValidacion',
        'subirComprobante',
        'entregar',
        'llamarSiguiente',
      ]),
    );
  });
});
