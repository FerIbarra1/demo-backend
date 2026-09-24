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

export const PedidoEnviado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoEnviadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${folioVisible(pedido)} ya va en camino`}
    title={`¡Tu pedido va en camino!`}
    greeting={`Hola, ${pedido.clienteNombre}. Tu pedido ${folioVisible(pedido)} salió de nuestras instalaciones y ya va en camino a la dirección que nos diste.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {pedido.paqueteria || pedido.direccionEnvio ? (
          <Callout
            variant="success"
            label={pedido.paqueteria ? `Enviado por ${pedido.paqueteria}` : 'Se enviará a'}
          >
            {pedido.direccionEnvio ??
              'Tu pedido viaja con la paquetería que elegiste al confirmar la compra.'}
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
          Recibirás otro correo en cuanto tu pedido sea entregado. Si necesitas
          rastrearlo, contáctanos con tu folio {folioVisible(pedido)}.
        </Text>
      </>
    }
  />
);
