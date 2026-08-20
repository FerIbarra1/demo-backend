import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData } from '../mail.templates';

export interface PedidoAprobadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoAprobado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoAprobadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${pedido.numeroPedido} está aprobado y listo para pagar`}
    title={`Tu pedido ${pedido.numeroPedido} está aprobado`}
    greeting={`Hola, ${pedido.clienteNombre}. Confirmamos la disponibilidad de tu pedido y ya quedó listo para pago.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ir a pagar"
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
        Acércate a la ventanilla de la tienda o sigue las instrucciones
        según el modo de entrega que elegiste. Te avisaremos por correo
        en cuanto el pago quede confirmado.
      </Text>
    }
  />
);
