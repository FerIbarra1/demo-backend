import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PagoConfirmadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PagoConfirmado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PagoConfirmadoProps) => (
  <PedidoEmailShell
    preview={`Pago confirmado de tu pedido ${folioVisible(pedido)}`}
    title={`¡Pago confirmado!`}
    greeting={`Hola, ${pedido.clienteNombre}. Recibimos el pago de tu pedido ${folioVisible(pedido)}.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <Text
        style={{
          fontSize: '14px',
          color: '#1c1917',
          margin: '0 0 8px 0',
          lineHeight: '1.6',
        }}
      >
        {pedido.direccionEnvio
          ? 'Te avisaremos por correo en cuanto tu pedido sea enviado.'
          : 'Ya puedes llevarte tu pedido: acércate al mostrador con tu folio y te lo entregamos.'}
      </Text>
    }
  />
);
