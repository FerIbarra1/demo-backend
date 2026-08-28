import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoAprobadoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
  qrDataUrl?: string | null;
}

export const PedidoAprobado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
  qrDataUrl,
}: PedidoAprobadoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${folioVisible(pedido)} está aprobado y listo para pagar`}
    title={`Tu pedido ${folioVisible(pedido)} está aprobado`}
    greeting={`Hola, ${pedido.clienteNombre}. Confirmamos la disponibilidad de tu pedido y ya quedó listo para pago.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ir a pagar"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
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
        {qrDataUrl ? (
          <div
            style={{
              textAlign: 'center',
              margin: '16px 0 8px 0',
            }}
          >
            <img
              src={qrDataUrl}
              alt={`QR del pedido ${folioVisible(pedido)}`}
              width={180}
              height={180}
              style={{ borderRadius: '8px' }}
            />
            <Text
              style={{
                fontSize: '12px',
                color: '#78716c',
                margin: '8px 0 0 0',
                lineHeight: '1.5',
              }}
            >
              Muestra este código QR en la tienda para agilizar tu pago.
            </Text>
          </div>
        ) : null}
      </>
    }
  />
);
