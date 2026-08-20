import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Callout } from './Callout';
import { PedidoEmailData } from '../mail.templates';

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
    preview={`Tu pedido ${pedido.numeroPedido} fue cancelado`}
    title={`Tu pedido fue cancelado`}
    greeting={`Hola, ${pedido.clienteNombre}. Te informamos que tu pedido ${pedido.numeroPedido} fue cancelado.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ver detalle"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <Callout
        variant="danger"
        label={pedido.motivoCancelacion ? 'Motivo' : 'Aviso'}
      >
        {pedido.motivoCancelacion ??
          'Si no solicitaste esta cancelación, por favor acércate a la tienda o contáctanos para ayudarte a resolverlo.'}
      </Callout>
    }
  />
);
