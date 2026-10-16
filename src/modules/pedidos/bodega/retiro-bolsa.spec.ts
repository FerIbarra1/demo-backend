import { BadRequestException } from '@nestjs/common';
import { EstadoPedido, EstadoSurtido, ModoEntrega, Prisma, RolUsuario } from '@prisma/client';
import { SurtidoService } from './surtido.service';

/**
 * F21 (oct 2026): el retiro de la bolsa del área de entrega.
 *
 * Dos huecos que este spec fija:
 *
 *   1. **`marcarItem` dejaba destruir el hallazgo físico.** `cantidadSurtida` es
 *      "lo que bodega encontró en el anaquel". Desde F21 un ajuste a la baja ya
 *      no lo pisa: deja el sobrante a la vista para que el bodeguero lo saque de
 *      la bolsa. Pero la fila del sheet se pinta con `cantidadSurtida` y clampa
 *      el input a `cantidad`, así que una línea con 3 en la bolsa y 1 pedida
 *      mostraba "3 / 1" — y al tocarla persistía `cantidadSurtida: 1`. El
 *      sobrante desaparecía del dato y la mercancía de más viajaba al área de
 *      entrega dentro de la bolsa.
 *
 *   2. **El retiro confirmado no se registraba.** El checklist del sheet vive en
 *      estado local del componente: al cerrarlo se perdía, y como
 *      `piezasFueraDeLaBolsa` es posicional (compara `cantidadSurtida` contra
 *      `cantidad`), un segundo ajuste volvía a pedir sacar prendas que ya
 *      estaban fuera de la bolsa.
 */

const usuario = {
  userId: 42,
  rol: RolUsuario.BODEGA,
  tiendaId: 5,
  nombre: 'Bodeguero',
};

function crearServicio(items: any[]) {
  const itemUpdates: Array<{ where: any; data: any }> = [];

  const prisma = {
    pedido: {
      findUnique: jest.fn(async () => ({
        id: 1,
        estado: EstadoPedido.EN_REVISION,
        tiendaId: 5,
        asignadoAId: usuario.userId,
        modoEntrega: ModoEntrega.KIOSKO,
        descuento: new Prisma.Decimal(0),
        impuestos: new Prisma.Decimal(0),
        items,
      })),
      update: jest.fn(async () => ({})),
    },
    itemPedido: {
      findUnique: jest.fn(async ({ where }: any) => {
        const it = items.find((i) => i.id === where.id);
        return it ? { ...it, precioUnitario: new Prisma.Decimal(100) } : null;
      }),
      update: jest.fn(async (args: any) => {
        itemUpdates.push(args);
        return {};
      }),
      findMany: jest.fn(async () => items.filter((i) => !i.cancelada)),
    },
    pedidoPropuesta: {
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 88 })),
    },
    pedidoReposicion: { create: jest.fn(async () => ({})) },
    pedidoMensaje: { create: jest.fn(async () => ({})) },
  };

  const state = {
    cambiarEstado: jest.fn(async (_id: number, dto: any, _u: any, o: any) => {
      if (o?.efectos) await o.efectos(prisma);
      return { id: 1, estado: dto.nuevoEstado };
    }),
  };

  const svc = new SurtidoService(
    prisma as never,
    { cargarYValidar: jest.fn(async () => ({ id: 1 })) } as never,
    state as never,
    { enviar: jest.fn() } as never,
    { emitToPedido: jest.fn(), emitToTienda: jest.fn(), emitToUser: jest.fn() } as never,
    { resolverImagen: jest.fn((u: any) => u) } as never,
  );

  return { svc, prisma, itemUpdates };
}

function item(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pedidoId: 1,
    cantidad: 5,
    cantidadSurtida: 5,
    piezasRetiradas: 0,
    estadoSurtido: EstadoSurtido.COMPLETO,
    cancelada: false,
    original: true,
    precioUnitario: new Prisma.Decimal(100),
    subtotal: new Prisma.Decimal(500),
    ...over,
  };
}

describe('marcarItem: el hallazgo físico del sobrante no se puede destruir', () => {
  /**
   * El guard de F16 (`cantidadSurtida > cantidad`) NO alcanza a protegerlo, y
   * ese es el punto de estos tests.
   *
   * Con sobrante se cumple `cantidad < cantidadSurtida`. El valor `dto = cantidad`
   * pasa el guard de F16 (no lo excede) y **sí** reduce el hallazgo. Y es
   * exactamente lo que manda la fila del sheet: se pinta con `cantidadSurtida`
   * (3) y clampa el input a `cantidad` (1), así que tocarla —"Hay todo" o
   * teclear— persiste `cantidadSurtida: 1`.
   */
  it('rechaza la marca que manda la fila del sheet (dto = cantidad)', async () => {
    // 3 en el anaquel, el cliente se lleva 1 → sobran 2. `dto = 1` pasa el tope
    // de F16 pero destruiría el sobrante.
    const { svc } = crearServicio([
      item({ id: 5, cantidad: 1, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    await expect(
      svc.marcarItem(
        1,
        5,
        { cantidadSurtida: 1, estadoSurtido: EstadoSurtido.COMPLETO } as never,
        usuario,
      ),
    ).rejects.toThrow(/de más en la bolsa/);
  });

  it('rechaza cualquier valor que reduzca el hallazgo', async () => {
    const { svc } = crearServicio([
      item({ id: 5, cantidad: 2, cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    // 0, 1 y 2 son todos menores que 5: los tres reducirían el hallazgo.
    for (const dto of [0, 1, 2]) {
      await expect(
        svc.marcarItem(
          1,
          5,
          { cantidadSurtida: dto, estadoSurtido: EstadoSurtido.COMPLETO } as never,
          usuario,
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('con sobrante NO existe ningún valor válido para marcar', async () => {
    // Con `cantidad=1` y `cantidadSurtida=3`: todo `dto <= 1` reduce el hallazgo
    // (rechazado por el guard de F21) y todo `dto > 1` excede lo pedido
    // (rechazado por el de F16). No hay salida por `marcarItem`.
    //
    // Es la justificación de que la fila NO se renderice como input editable en
    // el sheet: la única salida es el checklist de retiro.
    const { svc } = crearServicio([
      item({ id: 5, cantidad: 1, cantidadSurtida: 3, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    for (const dto of [0, 1, 2, 3, 5]) {
      await expect(
        svc.marcarItem(
          1,
          5,
          { cantidadSurtida: dto, estadoSurtido: EstadoSurtido.COMPLETO } as never,
          usuario,
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('permite bajar cuando NO hay sobrante (corregir una marca equivocada)', async () => {
    // Sin sobrante no hay nada que proteger: es el caso de "me equivoqué al
    // marcar" y el bodeguero tiene que poder corregirlo.
    const { svc } = crearServicio([
      item({ id: 6, cantidad: 5, cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    await expect(
      svc.marcarItem(
        1,
        6,
        { cantidadSurtida: 2, estadoSurtido: EstadoSurtido.PARCIAL } as never,
        usuario,
      ),
    ).resolves.toBeDefined();
  });
});

describe('confirmarSurtido: registrar el retiro de la bolsa', () => {
  it('suma las piezas retiradas de los items marcados en el checklist', async () => {
    // Una línea cancelada que tenía 3 piezas apartadas: el bodeguero las sacó.
    const { svc, itemUpdates } = crearServicio([
      item({
        id: 7,
        cantidad: 5,
        cantidadSurtida: 3,
        cancelada: true,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
      item({ id: 8, cantidad: 2, cantidadSurtida: 2 }),
    ]);

    await svc.confirmarSurtido(1, usuario, false, [7]);

    const incremento = itemUpdates.find(
      (u) => u.where.id === 7 && u.data?.piezasRetiradas?.increment != null,
    );
    expect(incremento?.data.piezasRetiradas.increment).toBe(3);
  });

  it('el incremento usa el total fuera de la bolsa, no lo que quedó tras el ajuste', async () => {
    // CRÍTICO: `aplicarCambiosSurtido` corre DENTRO de los mismos efectos y
    // escribe `cantidadSurtida: 0` sobre los NO_DISPONIBLE. Si el incremento se
    // calculara adentro, saldría 0 justo en el caso más común.
    //
    // El segundo item activo es necesario para pasar el guard de "activos
    // finales": sin él el pedido quedaría sin productos y `confirmarSurtido`
    // rechaza la operación (correctamente).
    const { svc, itemUpdates } = crearServicio([
      item({
        id: 9,
        cantidad: 5,
        cantidadSurtida: 4,
        cancelada: true,
        estadoSurtido: EstadoSurtido.NO_DISPONIBLE,
      }),
      item({ id: 12, cantidad: 2, cantidadSurtida: 2 }),
    ]);

    await svc.confirmarSurtido(1, usuario, false, [9]);

    const incremento = itemUpdates.find(
      (u) => u.where.id === 9 && u.data?.piezasRetiradas?.increment != null,
    );
    // 4 piezas estaban en la bolsa antes de que el ajuste limpiara el campo.
    expect(incremento?.data.piezasRetiradas.increment).toBe(4);
  });

  it('el incremento usa el PENDIENTE, no el total (segundo ajuste sobre la misma línea)', async () => {
    // El caso que rompía el contador. La línea ya tuvo un retiro: había 5, el
    // ajuste la dejó en 3 y el bodeguero sacó 2. Ahora un segundo ajuste la deja
    // en 1, así que el sobrante TOTAL es 4 — pero solo faltan 2 por sacar.
    //
    // Con el total, el contador quedaría en 6 sobre un sobrante real de 4, y al
    // cancelar la línea más adelante `piezasPendientesDeRetiro` clampearía a 0:
    // la última prenda, la que sigue físicamente en la bolsa, nunca se pediría
    // sacar. Es el fallo que la columna existe para prevenir.
    const { svc, itemUpdates } = crearServicio([
      item({
        id: 13,
        cantidad: 1,
        cantidadSurtida: 5,
        piezasRetiradas: 2,
        cancelada: false,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
      item({ id: 14, cantidad: 2, cantidadSurtida: 2 }),
    ]);

    await svc.confirmarSurtido(1, usuario, false, [13]);

    const incremento = itemUpdates.find(
      (u) => u.where.id === 13 && u.data?.piezasRetiradas?.increment != null,
    );
    // 4 fuera de la bolsa − 2 ya retiradas = 2 pendientes.
    expect(incremento?.data.piezasRetiradas.increment).toBe(2);
  });

  it('sin itemsRetirados no escribe nada (compatibilidad con el lote y los tests)', async () => {
    const { svc, itemUpdates } = crearServicio([item({ id: 10 })]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
    expect(itemUpdates.filter((u) => u.data?.piezasRetiradas != null)).toHaveLength(0);
  });

  it('ignora ids que no tienen piezas fuera de la bolsa', async () => {
    // Un item marcado por error en el checklist no debe inflar el conteo: el
    // número sale del predicado, no de lo que el cliente mande.
    const { svc, itemUpdates } = crearServicio([item({ id: 11, cantidad: 5, cantidadSurtida: 5 })]);

    await svc.confirmarSurtido(1, usuario, false, [11]);

    expect(itemUpdates.filter((u) => u.data?.piezasRetiradas != null)).toHaveLength(0);
  });
});

describe('confirmarSurtido: el guard de coherencia cuenta lo que HAY en la bolsa', () => {
  it('rechaza un COMPLETO cuya bolsa ya no cubre lo que se cobra', async () => {
    // Se encontraron 5 y el bodeguero sacó 2 en un ajuste: en la bolsa quedan 3.
    // Si la cantidad se cobra en 4, nadie apartó la cuarta pieza. Comparar contra
    // `cantidadSurtida` a secas (5) lo dejaba pasar y el cliente pagaba 4 con 3 en
    // la bolsa.
    const { svc } = crearServicio([
      item({
        id: 20,
        cantidad: 4,
        cantidadSurtida: 5,
        piezasRetiradas: 2,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).rejects.toThrow(
      /menos piezas apartadas[\s\S]*#20 \(3\/4\)/,
    );
  });

  it('deja pasar cuando la bolsa cubre exactamente lo que se cobra', async () => {
    const { svc } = crearServicio([
      item({
        id: 21,
        cantidad: 3,
        cantidadSurtida: 5,
        piezasRetiradas: 2,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false)).resolves.toBeDefined();
  });

  it('con el retiro PENDIENTE (aún dentro de la bolsa) no estorba al cierre', async () => {
    // Se encontraron 5, la cantidad bajó a 3 y el bodeguero apenas va a sacar las
    // 2: en la bolsa hay 5 ≥ 3. El guard no debe bloquear justo el cierre que
    // registra el retiro.
    const { svc } = crearServicio([
      item({
        id: 22,
        cantidad: 3,
        cantidadSurtida: 5,
        piezasRetiradas: 0,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario, false, [22])).resolves.toBeDefined();
  });
});

// =============================================================================
// Oct 2026 (decisión 2): bodega verifica SOLO las piezas de más de una línea que se subió
// =============================================================================
//
// Al subir de 3 a 5 con 3 en la bolsa, la línea queda PENDIENTE con
// `cantidadSurtida: 3` y `piezasBase: 3`. Bodega marca el TOTAL (3 + lo que
// encuentre) y nunca menos que `piezasBase`: esas 3 siguen dentro de la bolsa.

describe('marcarItem: el piso de una línea que se subió (piezasBase)', () => {
  const subida = (over: Partial<Record<string, unknown>> = {}) =>
    item({
      id: 9,
      cantidad: 5,
      cantidadSurtida: 3,
      piezasBase: 3,
      estadoSurtido: EstadoSurtido.PENDIENTE,
      ...over,
    });

  it('"Hay todo" (5) y "hay menos" (4) son válidos: se suma a lo que ya está en la bolsa', async () => {
    const { svc, itemUpdates } = crearServicio([subida()]);

    await svc.marcarItem(
      1,
      9,
      { cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO } as never,
      usuario,
    );
    await svc.marcarItem(
      1,
      9,
      { cantidadSurtida: 4, estadoSurtido: EstadoSurtido.PARCIAL } as never,
      usuario,
    );

    expect(itemUpdates.map((u) => u.data.cantidadSurtida)).toEqual([5, 4]);
  });

  it('"no hay más" es marcar el piso (3), que queda PARCIAL: la línea NO se cancela', async () => {
    const { svc, itemUpdates } = crearServicio([subida()]);

    await svc.marcarItem(
      1,
      9,
      { cantidadSurtida: 3, estadoSurtido: EstadoSurtido.PARCIAL } as never,
      usuario,
    );

    expect(itemUpdates[0].data).toMatchObject({
      cantidadSurtida: 3,
      estadoSurtido: EstadoSurtido.PARCIAL,
    });
  });

  it('rechaza "No hay" (0): cancelaría una línea con piezas dentro de la bolsa', async () => {
    // El caso que justifica la columna: `NO_DISPONIBLE` cancela la línea y
    // `datosDeFaltaDeBodega()` limpia el hallazgo, así que las 3 prendas quedarían
    // dentro de la bolsa sin que el checklist ni la reposición supieran de ellas.
    const { svc, itemUpdates } = crearServicio([subida()]);

    await expect(
      svc.marcarItem(
        1,
        9,
        { cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE } as never,
        usuario,
      ),
    ).rejects.toThrow(/ya tiene 3 pieza\(s\) dentro de la bolsa/);
    expect(itemUpdates).toHaveLength(0);
  });

  it.each([1, 2])('rechaza marcar %s, por debajo del piso', async (dto) => {
    const { svc } = crearServicio([subida()]);

    await expect(
      svc.marcarItem(
        1,
        9,
        { cantidadSurtida: dto, estadoSurtido: EstadoSurtido.PARCIAL } as never,
        usuario,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('el piso SOBREVIVE a la primera marca: corregir hacia abajo tras marcar también se rechaza', async () => {
    // Es lo que no se puede derivar: tras marcar 5, `cantidadSurtida` ya es el total
    // y se perdió cuántas estaban. Por eso la columna.
    const { svc } = crearServicio([
      subida({ cantidadSurtida: 5, estadoSurtido: EstadoSurtido.COMPLETO }),
    ]);

    await expect(
      svc.marcarItem(
        1,
        9,
        { cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE } as never,
        usuario,
      ),
    ).rejects.toThrow(/dentro de la bolsa/);
  });

  it('una línea sin piso (la normal) se marca como siempre, incluso "No hay"', async () => {
    const { svc } = crearServicio([
      item({ id: 3, cantidad: 5, cantidadSurtida: 0, estadoSurtido: EstadoSurtido.PENDIENTE }),
    ]);

    await expect(
      svc.marcarItem(
        1,
        3,
        { cantidadSurtida: 0, estadoSurtido: EstadoSurtido.NO_DISPONIBLE } as never,
        usuario,
      ),
    ).resolves.toBeDefined();
  });
});

describe('confirmarSurtido: el piso vive UNA ronda de surtido', () => {
  it('lo limpia en todas las líneas al cerrar', async () => {
    const { svc, prisma } = crearServicio([
      item({
        id: 9,
        cantidad: 5,
        cantidadSurtida: 5,
        piezasBase: 3,
        estadoSurtido: EstadoSurtido.COMPLETO,
      }),
    ]);
    (prisma.itemPedido as any).updateMany = jest.fn(async () => ({ count: 1 }));

    await svc.confirmarSurtido(1, usuario as never, false);

    expect((prisma.itemPedido as any).updateMany).toHaveBeenCalledWith({
      where: { pedidoId: 1, piezasBase: { gt: 0 } },
      data: { piezasBase: 0 },
    });
  });

  it('no escribe nada de más si ninguna línea tiene piso (el caso normal)', async () => {
    const { svc, prisma } = crearServicio([item({ id: 9, cantidad: 5, cantidadSurtida: 5 })]);
    (prisma.itemPedido as any).updateMany = jest.fn(async () => ({ count: 0 }));

    await svc.confirmarSurtido(1, usuario as never, false);

    expect((prisma.itemPedido as any).updateMany).not.toHaveBeenCalled();
  });

  it('no deja cerrar si la línea subida sigue PENDIENTE: bodega todavía no verifica lo de más', async () => {
    const { svc } = crearServicio([
      item({
        id: 9,
        cantidad: 5,
        cantidadSurtida: 3,
        piezasBase: 3,
        estadoSurtido: EstadoSurtido.PENDIENTE,
      }),
    ]);

    await expect(svc.confirmarSurtido(1, usuario as never, false)).rejects.toThrow(/aún PENDIENTE/);
  });

  it('una línea subida que bodega NO completa se liquida a lo que hay en la bolsa (PARCIAL)', async () => {
    // Bodega encontró 0 de las 2 extra: marca el piso (3) → PARCIAL. Al cerrar, la
    // línea queda en 3 (lo que hay en la bolsa), NO se cancela, y el cliente recibe
    // una propuesta por la diferencia.
    const { svc, prisma } = crearServicio([
      item({
        id: 9,
        cantidad: 5,
        cantidadSurtida: 3,
        piezasBase: 3,
        estadoSurtido: EstadoSurtido.PARCIAL,
      }),
    ]);
    (prisma.itemPedido as any).updateMany = jest.fn(async () => ({ count: 1 }));

    const r = await svc.confirmarSurtido(1, usuario as never, false);

    expect(r.incompleto).toBe(true);
    const liquidacion = (prisma.itemPedido.update as jest.Mock).mock.calls.find(
      ([a]: any) => a.where.id === 9,
    )![0].data;
    expect(liquidacion).toMatchObject({ cantidad: 3, estadoSurtido: EstadoSurtido.COMPLETO });
    expect(liquidacion.cancelada).toBeUndefined();
  });
});
