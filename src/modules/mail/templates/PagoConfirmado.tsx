import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData } from '../mail.templates';

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
    preview={`Pago confirmado de tu pedido ${pedido.numeroPedido}`}
    title={`¡Pago confirmado!`}
    greeting={`Hola, ${pedido.clienteNombre}. Recibimos el pago de tu pedido ${pedido.numeroPedido}. Ya estamos preparando todo para entregártelo.`}
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
        Te avisaremos por correo en cuanto tu pedido sea enviado (si es a
        domicilio) o esté listo para recoger en tienda.
      </Text>
    }
  />
);
