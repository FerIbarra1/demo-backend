import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { Callout } from './Callout';
import { PedidoEmailData } from '../mail.templates';

export interface RevisionPropuestaProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  mensajeBodeguero?: string;
  logoUrl: string;
  frontendUrl: string;
}

export const RevisionPropuesta = ({
  pedido,
  pedidoUrl,
  mensajeBodeguero,
  logoUrl,
  frontendUrl,
}: RevisionPropuestaProps) => (
  <PedidoEmailShell
    preview={`El bodeguero tiene una propuesta para tu pedido ${pedido.numeroPedido}`}
    title={`Tu pedido ${pedido.numeroPedido} tiene cambios propuestos`}
    greeting={`Hola, ${pedido.clienteNombre}. Nuestro bodeguero terminó de revisar tu pedido y detectó algo que queremos confirmar contigo antes de seguir.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Revisar y responder"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {mensajeBodeguero ? (
          <Callout variant="warning" label="Mensaje del bodeguero">
            {mensajeBodeguero}
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
          Revisa el detalle del pedido para ver exactamente qué se ajustó
          (sustituciones, cantidades o piezas no disponibles) y, si estás de
          acuerdo, confírmalo. Si no estás de acuerdo, puedes responder
          directamente desde el chat del pedido.
        </Text>
      </>
    }
  />
);
