import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { Callout } from './Callout';
import { PedidoEmailData } from '../mail.templates';

export interface PedidoEnviadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoEnviado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoEnviadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${pedido.numeroPedido} ya va en camino`}
    title={`¡Tu pedido va en camino!`}
    greeting={`Hola, ${pedido.clienteNombre}. Tu pedido ${pedido.numeroPedido} ya fue entregado a la paquetería y está en camino a la dirección que nos diste.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {pedido.direccionEnvio ? (
          <Callout variant="success" label="Se enviará a">
            {pedido.direccionEnvio}
          </Callout>
        ) : null}
        {pedido.numeroGuia ? (
          <Callout variant="info" label="Número de guía">
            {pedido.numeroGuia}
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
          Recibirás otro correo en cuanto tu pedido sea entregado.
        </Text>
      </>
    }
  />
);
