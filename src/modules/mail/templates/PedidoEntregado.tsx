import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData, folioVisible } from '../mail.templates';

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
    preview={`Tu pedido ${folioVisible(pedido)} fue entregado`}
    title={`¡Tu pedido fue entregado!`}
    greeting={`Hola, ${pedido.clienteNombre}. Gracias por tu compra en Punto Textil Mayoreo.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {/* Oct 2026: si lo recogió alguien que no es el titular (el mandadero, un familiar), el
            titular lo lee aquí. Es constancia, no un trámite: si no reconoce el nombre, que avise. */}
        {pedido.recogioNombre && (
          <Text
            style={{
              fontSize: '14px',
              color: '#1c1917',
              margin: '0 0 12px 0',
              lineHeight: '1.6',
              padding: '12px 14px',
              backgroundColor: '#f5f5f4',
              borderRadius: '8px',
            }}
          >
            <strong>Lo recogió:</strong> {pedido.recogioNombre}. Si no reconoces a esa persona,
            avísanos de inmediato.
          </Text>
        )}
        <Text
          style={{
            fontSize: '14px',
            color: '#1c1917',
            margin: '0 0 8px 0',
            lineHeight: '1.6',
          }}
        >
          Si tienes algún problema con los productos, acércate a la tienda o contáctanos: estamos
          para ayudarte.
        </Text>
      </>
    }
  />
);
