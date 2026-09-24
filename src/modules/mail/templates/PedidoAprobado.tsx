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
    preview={`Tu pedido ${folioVisible(pedido)} ya está listo para pagar`}
    title={`Tu pedido ${folioVisible(pedido)} ya está listo`}
    greeting={`Hola, ${pedido.clienteNombre}. Revisamos tu pedido y ya puedes pasar a pagar.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ver mi pedido"
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
          {pedido.direccionEnvio
            ? 'Tu pedido va a domicilio: ya puedes completar el pago y te avisaremos por correo en cuanto salga a camino.'
            : 'Presenta este folio en caja para completar tu pago. Si ya estás en la tienda, acércate a la ventanilla que te indiquen.'}
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
              Muestra este código QR en caja para agilizar tu pago.
            </Text>
          </div>
        ) : null}
      </>
    }
  />
);
