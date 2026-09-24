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
 * de pagar (estado EN_MOSTRADOR).
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
    greeting={`Hola, ${pedido.clienteNombre}. Apartamos tu pedido ${folioVisible(pedido)} en tienda y está listo para que lo revises antes de pagar.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Revisar mi pedido"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
        {pedido.tiendaNombre ? (
          <Callout variant="info" label="Te esperamos en">
            {pedido.tiendaNombre}
            {pedido.tiendaTelefono ? `\nTel. ${pedido.tiendaTelefono}` : ''}
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
          Revisa las piezas en el mostrador: si todo está como lo pediste,
          confírmalo y pasa a pagar. Si algo no te convence, puedes ajustarlo
          ahí mismo o responder desde el chat del pedido.
        </Text>
      </>
    }
  />
);
