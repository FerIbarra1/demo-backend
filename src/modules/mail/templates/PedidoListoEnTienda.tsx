import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { Callout } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoListoEnTiendaProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

/**
 * El pedido quedó apartado en tienda esperando que el cliente lo revise antes
 * de pagar (estado REVISADO).
 *
 * Este correo cubre un hueco real: el estado exige que el cliente se presente
 * físicamente, y antes no se le avisaba — se enteraba sólo si abría la app.
 * Por eso el mensaje es explícito sobre qué hacer y dónde.
 */
export const PedidoListoEnTienda = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoListoEnTiendaProps) => (
  <PedidoEmailShell
    preview={`Tu pedido ${folioVisible(pedido)} ya está listo en tienda`}
    title="Tu pedido ya está listo en tienda"
    greeting={`Hola, ${pedido.clienteNombre}. Ya apartamos tu pedido en tienda: pasa al mostrador para revisarlo antes de pagar.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Revisar mi pedido"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {/* Solo la DIRECCIÓN: el nombre de la tienda ya va en el resumen y el teléfono en el pie.
            Antes esta tarjeta repetía las dos cosas. */}
        {pedido.tiendaDireccion ? (
          <Callout variant="info" label="Dónde">
            {pedido.tiendaDireccion}
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
          En el mostrador te ayudan a revisar las piezas. Si todo está bien, te mandan a pagar; si
          algo no te convence, lo ajustan ahí mismo.
        </Text>
      </>
    }
  />
);
