import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData } from '../mail.templates';

export interface PedidoEntregadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoEntregado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoEntregadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${pedido.numeroPedido} fue entregado`}
    title={`¡Tu pedido fue entregado!`}
    greeting={`Hola, ${pedido.clienteNombre}. Confirmamos que tu pedido ${pedido.numeroPedido} ya fue entregado.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ver detalle de mi pedido"
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
        Gracias por tu compra. Si tienes algún problema con los productos,
        acércate a la tienda o contáctanos — estamos para ayudarte.
      </Text>
    }
  />
);
