import { BadRequestException } from '@nestjs/common';
import { CanalOrigen, ModoEntrega } from '@prisma/client';
import { CreatePedidoDto } from '../cliente/dto/create-pedido.dto';

/**
 * F8 (jul 2026): resuelve el `modoEntrega` del pedido. Si el frontend lo
 * mandó, se usa. Si no, se infiere de los campos de envío que llegaron y de
 * si el pedido es de kiosko. Valida coherencia con el canal (KIOSKO no puede
 * tener dirección, etc.) y con los requisitos de cada modo (DOMICILIO requiere
 * paquetería O admin decide, etc.).
 *
 * sep 2026: RECOGER_TIENDA ya no pide fecha ni hora de recogida. El modo se
 * elige explícitamente desde el checkout; no se infiere de ningún campo.
 */
export function resolverModoEntrega(
  dto: CreatePedidoDto,
  canalOrigenFinal: CanalOrigen,
  kioskoIdFinal: number | null,
): ModoEntrega {
  // Inferir modo si no llegó.
  let modo: ModoEntrega;
  const tieneDireccion =
    !!dto.shippingDireccion?.trim() ||
    !!dto.shippingColonia?.trim() ||
    !!dto.shippingCodigoPostal?.trim() ||
    !!dto.shippingPaqueteria ||
    dto.dejarAdminDecidePaqueteria === true;

  if (dto.modoEntrega) {
    modo = dto.modoEntrega;
  } else if (kioskoIdFinal) {
    modo = ModoEntrega.KIOSKO;
  } else if (tieneDireccion) {
    modo = ModoEntrega.DOMICILIO;
  } else {
    throw new BadRequestException(
      'No se pudo determinar el modo de entrega. Especifica modoEntrega o proporciona una dirección de envío.',
    );
  }

  // Validar coherencia por modo.
  if (modo === ModoEntrega.KIOSKO) {
    if (canalOrigenFinal !== CanalOrigen.KIOSKO) {
      throw new BadRequestException(
        'Un pedido con modo de entrega KIOSKO requiere canalOrigen=KIOSKO',
      );
    }
    if (tieneDireccion) {
      throw new BadRequestException(
        'Pedidos de kiosko no pueden tener dirección de envío (siempre se recogen en tienda)',
      );
    }
  }

  if (modo === ModoEntrega.DOMICILIO) {
    if (!dto.shippingDireccion?.trim()) {
      throw new BadRequestException(
        'Falta la dirección de envío (calle y número) para modo de entrega a domicilio',
      );
    }
    if (!dto.shippingColonia?.trim()) {
      throw new BadRequestException('Falta la colonia para envío a domicilio');
    }
    if (!dto.shippingCodigoPostal?.trim()) {
      throw new BadRequestException('Falta el código postal para envío a domicilio');
    }
    const tienePaqueteria = !!dto.shippingPaqueteria;
    const dejaAdmin = dto.dejarAdminDecidePaqueteria === true;
    if (tienePaqueteria && dejaAdmin) {
      throw new BadRequestException(
        'Elige una paquetería o marca "Dejar que el administrador decida", pero no ambos',
      );
    }
    if (!tienePaqueteria && !dejaAdmin) {
      throw new BadRequestException(
        'Para envío a domicilio debes elegir una paquetería o "Dejar que el administrador decida"',
      );
    }
  }

  if (modo === ModoEntrega.RECOGER_TIENDA) {
    if (canalOrigenFinal === CanalOrigen.KIOSKO) {
      throw new BadRequestException(
        'Pedidos de kiosko no pueden elegir RECOGER_TIENDA (su modo es KIOSKO)',
      );
    }
    if (tieneDireccion) {
      throw new BadRequestException(
        'No puedes tener dirección de envío y recoger en tienda al mismo tiempo',
      );
    }
  }

  return modo;
}
