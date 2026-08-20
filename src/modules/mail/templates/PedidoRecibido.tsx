import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData } from '../mail.templates';

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
    preview={`Recibimos tu pedido ${pedido.numeroPedido}`}
    title={`¡Recibimos tu pedido ${pedido.numeroPedido}!`}
    greeting={`Hola, ${pedido.clienteNombre}. Tu pedido entró a nuestra cola y en breve un bodeguero lo revisará para confirmar disponibilidad y precio.`}
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
        Te avisaremos por correo cada vez que tu pedido avance: propuesta
        del bodeguero, pago confirmado, envío y entrega.
      </Text>
    }
  />
);
