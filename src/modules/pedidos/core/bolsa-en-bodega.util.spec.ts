import { EstadoPedido } from '@prisma/client';
import { bolsaEnManosDeBodega } from './bolsa-en-bodega.util';

/**
 * Oct 2026: ¿la mercancía está en las manos de bodega?
 *
 * Es lo que decide si cancelar un pedido genera lista de reposición. El reporte
 * del negocio: si el pedido se cancela sin surtir o a medias, el bodeguero lo
 * trae en las manos y lo regresa al anaquel él mismo — no es trabajo para una
 * lista.
 */

function prismaCon(cerroSurtidoAntes: boolean) {
  const findFirst = jest.fn().mockResolvedValue(cerroSurtidoAntes ? { id: 1 } : null);
  return { prisma: { historialPedido: { findFirst } }, findFirst };
}

const pedido = (estado: EstadoPedido, asignadoAId: number | null = null) => ({
  id: 7,
  estado,
  asignadoAId,
});

describe('bolsaEnManosDeBodega', () => {
  it('SOLICITADO: nadie ha tocado el anaquel', async () => {
    const { prisma, findFirst } = prismaCon(false);
    await expect(bolsaEnManosDeBodega(prisma, pedido(EstadoPedido.SOLICITADO))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('EN_REVISION con bodeguero: lo está surtiendo ahora mismo', async () => {
    const { prisma, findFirst } = prismaCon(true);
    await expect(bolsaEnManosDeBodega(prisma, pedido(EstadoPedido.EN_REVISION, 42))).resolves.toBe(
      true,
    );
    // Aunque el pedido haya cerrado un surtido antes (ajuste en curso), el
    // bodeguero lo tiene en las manos: no hace falta mirar el historial.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('EN_REVISION sin bodeguero y NUNCA surtido: no hay bolsa en ningún lado', async () => {
    const { prisma } = prismaCon(false);
    await expect(bolsaEnManosDeBodega(prisma, pedido(EstadoPedido.EN_REVISION))).resolves.toBe(
      true,
    );
  });

  it('EN_REVISION sin bodeguero que VOLVIÓ del área de entrega: su bolsa sigue en la mesa', async () => {
    const { prisma } = prismaCon(true);
    await expect(bolsaEnManosDeBodega(prisma, pedido(EstadoPedido.EN_REVISION))).resolves.toBe(
      false,
    );
  });

  it('el historial se consulta por los destinos posteriores al surtido', async () => {
    const { prisma, findFirst } = prismaCon(false);
    await bolsaEnManosDeBodega(prisma, pedido(EstadoPedido.EN_REVISION));

    const { where } = findFirst.mock.calls[0][0];
    expect(where.pedidoId).toBe(7);
    expect(where.estadoAnterior).toBe(EstadoPedido.EN_REVISION);
    // Incluye PENDIENTE_PAGO: el domicilio salta el área de entrega.
    expect(where.estadoNuevo.in).toEqual([
      EstadoPedido.REVISADO,
      EstadoPedido.ESPERANDO_APROBACION,
      EstadoPedido.PENDIENTE_PAGO,
    ]);
  });

  it.each([
    EstadoPedido.REVISADO,
    EstadoPedido.EN_ATENCION,
    EstadoPedido.ESPERANDO_APROBACION,
    EstadoPedido.EN_ASESORIA,
    EstadoPedido.PENDIENTE_PAGO,
  ])('%s: la bolsa ya salió de bodega', async (estado) => {
    const { prisma, findFirst } = prismaCon(false);
    await expect(bolsaEnManosDeBodega(prisma, pedido(estado))).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
