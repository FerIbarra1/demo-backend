import { plainToInstance } from 'class-transformer';
import { validateSync, getMetadataStorage } from 'class-validator';
import { CrearMensajeConAdjuntoDto, PropuestaAdjuntaItemDto } from '../../messages/dto/mensaje.dto';

/**
 * F21 (oct 2026): el contrato de ENTRADA de una propuesta.
 *
 * Por qué existe este spec, que es distinto de todos los demás del repo: los
 * otros prueban los UTILS, y los utils no pasan por el `ValidationPipe`. Este
 * prueba la FRONTERA — lo que el `ValidationPipe` global acepta o rechaza.
 *
 * El bug que lo motivó: `cantidadDisponible` se agregó a `ItemPropuestaJson` (el
 * tipo de SALIDA, el snapshot que se guarda) pero no a `PropuestaItemDto` (el de
 * ENTRADA). El `ValidationPipe` de `main.ts` corre con `forbidNonWhitelisted:
 * true`, así que el editor del asesor —que manda la propuesta completa por
 * `POST /pedidos/:id/mensajes/con-adjunto`— habría recibido un **400** al enviar
 * cualquier propuesta que ajustara una cantidad.
 *
 * Ningún test lo veía: los specs llaman a `aplicarPropuestaDeVentas` y a
 * `construirPropuestaDeBodega` directamente, así que el pipe nunca entra en
 * juego. Es un fallo que solo aparece en producción, con el asesor enfrente.
 *
 * La lección: cuando un campo se agrega al tipo de SALIDA y el mismo objeto
 * viaja de vuelta como ENTRADA, hay que declararlo en los dos sitios.
 */

/**
 * Corre el mismo `ValidationPipe` que `main.ts`, con sus mismas opciones, y
 * aplana los errores de los objetos ANIDADOS.
 *
 * La recursión es imprescindible: los items viven dentro de `items`, así que sus
 * errores —incluido el de "campo no permitido"— llegan en `children`, no en la
 * raíz. Sin bajar, el helper devolvía siempre `[]` y TODOS los tests de este spec
 * pasaban en falso, incluido el que verifica que el pipe rechaza de verdad.
 */
function validar(dto: object): string[] {
  const instancia = plainToInstance(CrearMensajeConAdjuntoDto, dto);
  const errores = validateSync(instancia, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  const aplanar = (lista: typeof errores, prefijo = ''): string[] =>
    lista.flatMap((e) => {
      const ruta = prefijo ? `${prefijo}.${e.property}` : e.property;
      const propios = Object.keys(e.constraints ?? {}).map(
        (k) => `${ruta}: ${e.constraints![k]}`,
      );
      return [...propios, ...aplanar(e.children ?? [], ruta)];
    });

  return aplanar(errores);
}

/** Una propuesta mínima y válida, para ir agregando campos encima. */
function propuestaBase(items: object[]) {
  return { contenido: "Ajustes propuestos", propuestaItems: items, total: 100 };
}

const itemParcial = {
  itemId: 1,
  tipo: 'parcial',
  producto: 'Camiseta',
  variante: 'M · Negro',
  cantidad: 5,
  precioUnitario: 100,
  subtotal: 500,
  cantidadOriginal: 5,
  cantidadNueva: 2,
};

describe('F21 — el DTO de entrada acepta todo lo que el snapshot de salida lleva', () => {
  it('acepta `cantidadDisponible` (el número del medio, "Hay N")', () => {
    // Sin esta declaración el `ValidationPipe` responde 400 y el asesor no puede
    // enviar la propuesta. Es el bug que este spec previene.
    const errores = validar(
      propuestaBase([{ ...itemParcial, cantidadDisponible: 3 }]),
    );
    expect(errores).toEqual([]);
  });

  it('acepta el snapshot completo de un `parcial`', () => {
    const errores = validar(propuestaBase([itemParcial]));
    expect(errores).toEqual([]);
  });

  it('acepta el snapshot de un `cambio`', () => {
    const errores = validar(
      propuestaBase([
        {
          ...itemParcial,
          tipo: 'cambio',
          productoNuevo: 'Otra prenda',
          varianteNueva: 'L · Azul',
          cantidadNueva: 3,
          precioUnitarioNuevo: 120,
          subtotalNuevo: 360,
          precioCOId: 42,
        },
      ]),
    );
    expect(errores).toEqual([]);
  });

  it('acepta el snapshot de un `agregado`', () => {
    const errores = validar(
      propuestaBase([
        {
          itemId: -1,
          tipo: 'agregado',
          producto: 'Prenda nueva',
          variante: 'L · Azul',
          cantidad: 2,
          precioUnitario: 100,
          subtotal: 200,
          tempId: -1,
          productoId: 9,
          precioCOId: 42,
        },
      ]),
    );
    expect(errores).toEqual([]);
  });


  it('acepta el payload EXACTO que falló: 3 líneas, la 2ª con cantidadDisponible', () => {
    // Reproduce el reporte del usuario, que devolvía
    // `propuestaItems.1.property cantidadDisponible should not exist`.
    //
    // El índice 1 es la SEGUNDA línea: quitó un producto completo, bajó la
    // cantidad de uno parcial y dejó el otro igual. La línea bajada es la que
    // manda `cantidadDisponible`, y el pipe la rechazaba por no estar declarada
    // en `PropuestaAdjuntaItemDto` — el DTO real del endpoint.
    const errores = validar(
      propuestaBase([
        // 1. Quitado: el cliente ya no lo quiere.
        {
          itemId: 10,
          tipo: 'no-disponible',
          producto: 'Playera A',
          productoCodigo: 'D0300',
          variante: 'M · Negro',
          cantidad: 3,
          precioUnitario: 65,
          subtotal: 195,
          ajusteExplicito: true,
          cantidadDisponible: 3,
        },
        // 2. Bajado: había 3 y se lleva 2. ESTA es la línea que fallaba.
        {
          itemId: 11,
          tipo: 'parcial',
          producto: 'Playera B',
          productoCodigo: 'D0301',
          variante: 'S · Rojo',
          cantidad: 3,
          precioUnitario: 65,
          subtotal: 195,
          cantidadOriginal: 3,
          cantidadNueva: 2,
          ajusteExplicito: true,
          cantidadDisponible: 3,
          precioUnitarioNuevo: 65,
          subtotalNuevo: 130,
        },
        // 3. Sin tocar: solo se reporta el pedido completo.
        {
          itemId: 12,
          tipo: 'completo',
          producto: 'Playera C',
          productoCodigo: 'D0302',
          variante: 'L · Blanco',
          cantidad: 2,
          precioUnitario: 65,
          subtotal: 130,
        },
      ]),
    );
    expect(errores).toEqual([]);
  });

  it('acepta `ajusteExplicito` (la marca de causalidad)', () => {
    const errores = validar(
      propuestaBase([{ ...itemParcial, ajusteExplicito: true, cantidadDisponible: 3 }]),
    );
    expect(errores).toEqual([]);
  });

  it('RECHAZA un `total` que no es número', () => {
    // El backend recalcula el total, pero un valor basura no debe colarse en
    // silencio: el contrato dice número.
    const errores = validar({
      contenido: 'Ajustes',
      propuestaItems: [itemParcial],
      total: 'cien',
    });
    expect(errores.join(' ')).toContain('total');
  });

  it('RECHAZA un campo que no está en el DTO (así se comporta el pipe real)', () => {
    // La otra cara del contrato: si esto dejara de fallar, el spec de arriba
    // pasaría por la razón equivocada (el pipe no estaría validando nada).
    const errores = validar(
      propuestaBase([{ ...itemParcial, campoInventado: 'x' }]),
    );
    expect(errores.length).toBeGreaterThan(0);
    expect(errores.join(' ')).toContain('campoInventado');
  });

  it('la propuesta debe traer al menos un item', () => {
    const instancia = plainToInstance(CrearMensajeConAdjuntoDto, propuestaBase([]));
    expect(instancia.propuestaItems).toEqual([]);
  });
});

describe('F21 — `PropuestaItemDto` cubre el snapshot completo', () => {
  it('declara todos los campos que `ItemPropuestaJson` puede llevar', () => {
    // Guardia contra la próxima vez: si alguien agrega un campo al tipo de
    // salida y se olvida del de entrada, este test lo dice por su nombre.
    const camposDelSnapshot = [
      'itemId',
      'tipo',
      'producto',
      'productoCodigo',
      'variante',
      'productoImagen',
      'cantidad',
      'precioUnitario',
      'subtotal',
      'productoOriginal',
      'varianteOriginal',
      'cantidadOriginal',
      'cantidadDisponible',
      'productoNuevo',
      'varianteNueva',
      'cantidadNueva',
      'precioUnitarioNuevo',
      'subtotalNuevo',
      'tempId',
      'productoId',
      'precioCOId',
    ];

    // `Object.keys(new Dto())` no sirve: los campos sin inicializador no existen
    // como propiedades propias. Se leen los METADATOS que class-validator registra
    // con cada decorador, que es la lista real de lo que el pipe conoce.
    const declarados = getMetadataStorage()
      .getTargetValidationMetadatas(PropuestaAdjuntaItemDto, '', false, false)
      .map((m) => m.propertyName);
    const faltantes = camposDelSnapshot.filter((c) => !declarados.includes(c));

    expect(faltantes).toEqual([]);
  });
});
