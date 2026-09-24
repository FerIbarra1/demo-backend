import * as React from 'react';
import { Text } from '@react-email/components';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Callout } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoCanceladoProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

export const PedidoCancelado = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoCanceladoProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${folioVisible(pedido)} fue cancelado`}
    title={`Tu pedido ${folioVisible(pedido)} fue cancelado`}
    greeting={`Hola, ${pedido.clienteNombre}. Te informamos que tu pedido ${folioVisible(pedido)} quedó cancelado.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ver detalle"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        <Callout
          variant="danger"
          label={pedido.motivoCancelacion ? 'Motivo' : 'Aviso'}
        >
          {pedido.motivoCancelacion ??
            'Si no solicitaste esta cancelación, responde a este correo o acércate a la tienda para ayudarte a resolverlo.'}
        </Callout>
        {/* La pregunta inmediata tras una cancelación en B2B es qué pasa con
            el dinero ya transferido. Antes el correo no la respondía. */}
        <Text
          style={{
            fontSize: '14px',
            color: '#1c1917',
            margin: '0 0 8px 0',
            lineHeight: '1.6',
          }}
        >
          Si ya habías pagado, tu asesor de ventas te contactará para coordinar
          el reembolso o dejarlo como saldo a favor en tu próxima compra.
        </Text>
      </>
    }
  />
);
