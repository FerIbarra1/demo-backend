import { BadRequestException } from '@nestjs/common';
import { CanalOrigen, ModoEntrega } from '@prisma/client';
import { CreatePedidoDto } from '../cliente/dto/create-pedido.dto';

/**
 * F8 (jul 2026): resuelve el `modoEntrega` del pedido. Si el frontend lo
 * mandó, se usa. Si no, se infiere de los campos de envío/recogida que
 * llegaron y de si el pedido es de kiosko. Valida coherencia con el canal
 * (KIOSKO no puede tener dirección, etc.) y con los requisitos de cada
 * modo (DOMICILIO requiere paquetería O admin decide, etc.).
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
  const tieneRecogida = !!dto.recogerProgramado;

  if (dto.modoEntrega) {
    modo = dto.modoEntrega;
  } else if (kioskoIdFinal) {
    modo = ModoEntrega.KIOSKO;
  } else if (tieneDireccion) {
    modo = ModoEntrega.DOMICILIO;
  } else if (tieneRecogida) {
    modo = ModoEntrega.RECOGER_TIENDA;
  } else {
    throw new BadRequestException(
      'No se pudo determinar el modo de entrega. Especifica modoEntrega o proporciona dirección/horario de recogida.',
    );
  }

  // Validar coherencia por modo.
  if (modo === ModoEntrega.KIOSKO) {
    if (canalOrigenFinal !== CanalOrigen.KIOSKO) {
      throw new BadRequestException(
        'Un pedido con modo de entrega KIOSKO requiere canalOrigen=KIOSKO',
      );
    }
    if (tieneDireccion || tieneRecogida) {
      throw new BadRequestException(
        'Pedidos de kiosko no pueden tener dirección de envío ni horario de recogida (siempre se recogen en tienda)',
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
        'Pedidos de kiosko no pueden elegir horario de recogida (recogen directamente)',
      );
    }
    if (!dto.recogerProgramado) {
      throw new BadRequestException(
        'Para recoger en tienda debes seleccionar un día y hora de recogida',
      );
    }
    if (tieneDireccion) {
      throw new BadRequestException(
        'No puedes tener dirección de envío y horario de recogida al mismo tiempo',
      );
    }
  }

  return modo;
}
