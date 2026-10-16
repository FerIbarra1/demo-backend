import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { Callout } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoEnviadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoEnviado = ({ pedido, pedidoUrl, logoUrl, frontendUrl }: PedidoEnviadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${folioVisible(pedido)} ya va en camino`}
    title={`¡Tu pedido va en camino!`}
    greeting={`Hola, ${pedido.clienteNombre}. Tu pedido ya salió de nuestras instalaciones y va hacia la dirección que registraste.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {/* La paquetería ya va en el resumen ("Paquetería:"): aquí solo la dirección, que es lo
            que el cliente debe poder verificar. Antes se repetía la paquetería en una tarjeta y
            en una frase. */}
        {pedido.direccionEnvio ? (
          <Callout variant="success" label="Se envía a">
            {pedido.direccionEnvio}
          </Callout>
        ) : null}
        <Text
          style={{
            fontSize: '14px',
            color: '#1c1917',
            margin: '0 0 8px 0',
            lineHeight: '1.6',
          }}
        >
          Te avisaremos por correo cuando se entregue. Si necesitas rastrearlo, contáctanos con tu
          folio.
        </Text>
      </>
    }
  />
);
