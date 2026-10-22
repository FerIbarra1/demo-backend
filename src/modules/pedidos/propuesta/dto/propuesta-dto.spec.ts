import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CrearMensajeConAdjuntoDto } from '../../messages/dto/mensaje.dto';
import { VistaPreviaAjusteDto } from './ajuste.dto';

/**
 * El contrato de ENTRADA de un ajuste (Fase 2, oct 2026).
 *
 * Por qué existe este spec, distinto de los demás del repo: los otros prueban los
 * UTILS, y los utils no pasan por el `ValidationPipe`. Este prueba la FRONTERA —
 * lo que el `ValidationPipe` global acepta o rechaza.
 *
 * Historia: F21 perdió un día porque `cantidadDisponible` se agregó al tipo de
 * SALIDA (el snapshot) y no al DTO de ENTRADA; con `forbidNonWhitelisted: true`
 * el asesor no podía enviar ninguna propuesta que ajustara una cantidad, y ningún
 * test lo veía.
 *
 * Fase 2 cierra esa clase de bug de raíz: el cliente de la API ya no manda el
 * snapshot, manda su INTENCIÓN (`ajuste`), y el servidor arma el resto. No hay un
 * tipo de salida que mantener en sincronía con uno de entrada. Lo que este spec
 * fija ahora es lo contrario: que el cliente NO PUEDA mandar precios.
 */

/** Corre las mismas opciones que el `ValidationPipe` de `main.ts` y aplana los errores anidados. */
function validar<T extends object>(clase: new () => T, dto: object): string[] {
  const instancia = plainToInstance(clase, dto);
  const errores = validateSync(instancia, { whitelist: true, forbidNonWhitelisted: true });

  const aplanar = (lista: typeof errores, prefijo = ''): string[] =>
    lista.flatMap((e) => {
      const ruta = prefijo ? `${prefijo}.${e.property}` : e.property;
      const propios = Object.keys(e.constraints ?? {}).map((k) => `${ruta}: ${e.constraints![k]}`);
      return [...propios, ...aplanar(e.children ?? [], ruta)];
    });

  return aplanar(errores);
}

const enChat = (ajuste: object[], extra: object = {}) => ({
  contenido: 'Te propongo estos ajustes',
  ajuste,
  ...extra,
});
const enVistaPrevia = (intenciones: object[]) => ({ intenciones });

describe('IntencionAjusteDto — lo que el asesor puede decir', () => {
  it.each([
    ['CANTIDAD', { accion: 'CANTIDAD', itemId: 1, cantidad: 3 }],
    ['QUITAR', { accion: 'QUITAR', itemId: 1 }],
    ['AGREGAR', { accion: 'AGREGAR', precioCOId: 9, cantidad: 5 }],
    ['REPONER', { accion: 'REPONER', itemId: 1, cantidad: 3 }],
  ])('acepta %s', (_n, intencion) => {
    expect(validar(CrearMensajeConAdjuntoDto, enChat([intencion]))).toEqual([]);
    expect(validar(VistaPreviaAjusteDto, enVistaPrevia([intencion]))).toEqual([]);
  });

  it('acepta varias intenciones a la vez', () => {
    const errores = validar(
      CrearMensajeConAdjuntoDto,
      enChat([
        { accion: 'CANTIDAD', itemId: 1, cantidad: 3 },
        { accion: 'QUITAR', itemId: 2 },
        { accion: 'AGREGAR', precioCOId: 9, cantidad: 5 },
      ]),
    );
    expect(errores).toEqual([]);
  });

  it('RECHAZA una acción inventada', () => {
    expect(
      validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'REGALAR', itemId: 1 }])).length,
    ).toBeGreaterThan(0);
  });

  it('CANTIDAD exige itemId y una cantidad de al menos 1', () => {
    expect(
      validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'CANTIDAD', cantidad: 3 }])).join(' '),
    ).toContain('itemId');
    expect(
      validar(
        VistaPreviaAjusteDto,
        enVistaPrevia([{ accion: 'CANTIDAD', itemId: 1, cantidad: 0 }]),
      ).join(' '),
    ).toContain('cantidad');
  });

  it('REPONER exige el itemId y una cantidad de al menos 1', () => {
    expect(
      validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'REPONER', cantidad: 3 }])).join(' '),
    ).toContain('itemId');
    expect(
      validar(
        VistaPreviaAjusteDto,
        enVistaPrevia([{ accion: 'REPONER', itemId: 1, cantidad: 0 }]),
      ).join(' '),
    ).toContain('cantidad');
    expect(
      validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'REPONER', itemId: 1 }])).join(' '),
    ).toContain('cantidad');
  });

  it('REPONER no acepta un precio: el servidor lo calcula', () => {
    expect(
      validar(
        VistaPreviaAjusteDto,
        enVistaPrevia([{ accion: 'REPONER', itemId: 1, cantidad: 2, precioUnitario: 0 }]),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('AGREGAR exige la variante', () => {
    expect(
      validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'AGREGAR', cantidad: 2 }])).join(' '),
    ).toContain('precioCOId');
  });

  it('QUITAR no necesita cantidad', () => {
    expect(validar(VistaPreviaAjusteDto, enVistaPrevia([{ accion: 'QUITAR', itemId: 1 }]))).toEqual(
      [],
    );
  });

  it('rechaza cantidades absurdas', () => {
    expect(
      validar(
        VistaPreviaAjusteDto,
        enVistaPrevia([{ accion: 'CANTIDAD', itemId: 1, cantidad: 100000 }]),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('el cliente de la API NO puede influir en un precio', () => {
  // La razón de la Fase 2: antes el navegador mandaba nombre, precio, subtotal y
  // "antes/después" de cada línea y el servidor los guardaba tal cual.
  const camposDeDinero = [
    'precioUnitario',
    'subtotal',
    'subtotalOriginal',
    'precioUnitarioNuevo',
    'subtotalNuevo',
  ];

  it.each(camposDeDinero)('RECHAZA `%s` dentro de una intención', (campo) => {
    const errores = validar(
      VistaPreviaAjusteDto,
      enVistaPrevia([{ accion: 'CANTIDAD', itemId: 1, cantidad: 3, [campo]: 1 }]),
    );
    expect(errores.join(' ')).toContain(campo);
  });

  it('RECHAZA `total` en el cuerpo del mensaje', () => {
    const errores = validar(
      CrearMensajeConAdjuntoDto,
      enChat([{ accion: 'QUITAR', itemId: 1 }], { total: 0 }),
    );
    expect(errores.join(' ')).toContain('total');
  });

  it('RECHAZA el formato viejo `propuestaItems`: ya no hay snapshot que armar en el navegador', () => {
    const errores = validar(CrearMensajeConAdjuntoDto, {
      contenido: 'x',
      propuestaItems: [{ itemId: 1, tipo: 'parcial' }],
    });
    expect(errores.join(' ')).toContain('propuestaItems');
  });
});

describe('CrearMensajeConAdjuntoDto — el texto', () => {
  it('es obligatorio cuando NO hay propuesta', () => {
    expect(validar(CrearMensajeConAdjuntoDto, { contenido: '' }).join(' ')).toContain('contenido');
  });

  it('es opcional cuando SÍ hay propuesta (el servidor pone un texto por defecto)', () => {
    expect(
      validar(
        CrearMensajeConAdjuntoDto,
        enChat([{ accion: 'QUITAR', itemId: 1 }], { contenido: '' }),
      ),
    ).toEqual([]);
  });
});
