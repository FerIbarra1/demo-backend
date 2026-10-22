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
    title="Tu pedido ya está listo para pagar"
    greeting={`Hola, ${pedido.clienteNombre}. Ya revisamos tu pedido y puedes completar tu pago.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel={pedido.pagoPorTransferencia ? 'Ver datos para transferir' : 'Ver mi pedido'}
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
          {/* Un solo mensaje de "cómo pagar", según lo que el cliente eligió: antes decía "presenta
              este folio" y, debajo del QR, "muestra este código" (lo mismo dos veces), y a quien
              transfiere le daba instrucciones de caja. */}
          {pedido.pagoPorTransferencia
            ? 'Elegiste pagar por transferencia: entra a tu pedido para ver los datos y subir tu comprobante.'
            : pedido.direccionEnvio
              ? 'Tu pedido va a domicilio. Cuando se confirme el pago te avisaremos por correo en cuanto salga con la paquetería.'
              : qrDataUrl
                ? 'Muestra este código en caja para pagar. Si ya estás en la tienda, acércate a la ventanilla que te indiquen.'
                : 'Presenta tu folio en caja para pagar. Si ya estás en la tienda, acércate a la ventanilla que te indiquen.'}
        </Text>
        {qrDataUrl && !pedido.pagoPorTransferencia ? (
          <div style={{ textAlign: 'center', margin: '16px 0 8px 0' }}>
            <img
              src={qrDataUrl}
              alt={`Código QR del folio ${folioVisible(pedido)}`}
              width={180}
              height={180}
              style={{ borderRadius: '8px' }}
            />
          </div>
        ) : null}
      </>
    }
  />
);
