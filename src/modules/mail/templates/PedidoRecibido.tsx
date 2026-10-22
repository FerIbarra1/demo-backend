import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoRecibidoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoRecibido = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoRecibidoProps) => (
  <PedidoEmailShell
    preview={`Recibimos tu pedido ${folioVisible(pedido)}`}
    title="¡Recibimos tu pedido!"
    greeting={`Hola, ${pedido.clienteNombre}. Recibimos tu pedido y nuestro equipo ya lo está preparando: confirmaremos que tenemos todas las piezas.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <Text
        style={{
          fontSize: '14px',
          color: '#1c1917',
          margin: '0 0 16px 0',
          lineHeight: '1.6',
        }}
      >
        {pedido.pagoPorTransferencia
          ? 'Elegiste pagar por transferencia: cuando tu pedido esté listo para pagar verás los datos en tu pedido. '
          : ''}
        {pedido.direccionEnvio
          ? 'Te avisaremos por correo en cada paso: si hay cambios en tu pedido, al confirmarse el pago, cuando salga a envío y en la entrega.'
          : 'Te avisaremos por correo en cada paso: si hay cambios en tu pedido, cuando esté listo para revisar en tienda, al confirmarse el pago y en la entrega.'}
      </Text>
    }
  />
);
