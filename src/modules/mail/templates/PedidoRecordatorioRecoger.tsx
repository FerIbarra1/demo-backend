import * as React from 'react';
import { Text } from '@react-email/components';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Callout } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export interface PedidoRecordatorioRecogerProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
}

/**
 * "¿Aún quieres tu pedido?" (F22, oct 2026).
 *
 * La bolsa lleva más de un día apartada en el área de entrega y el cliente no ha
 * pasado ni avisado su llegada. El correo le pide UNA decisión y le da las dos
 * salidas en el mismo lugar: entrar al pedido para decir "sigo interesado" o
 * para cancelarlo. Si no responde, el mostrador lo cancela pasado el plazo (y le
 * llega el correo de cancelación con el motivo).
 *
 * Es importante que el correo diga QUÉ pasa si no hace nada: sin eso la
 * cancelación posterior se siente como un castigo y no como un aviso cumplido.
 */
export const PedidoRecordatorioRecoger = ({
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
}: PedidoRecordatorioRecogerProps) => (
  <PedidoEmailShell
    preview={`¿Aún quieres tu pedido ${folioVisible(pedido)}?`}
    title="¿Aún quieres tu pedido?"
    greeting={`Hola, ${pedido.clienteNombre}. Tu pedido sigue apartado en tienda esperando a que pases por él.`}
    pedido={pedido}
    pedidoUrl={pedidoUrl}
    ctaLabel="Ver mi pedido"
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
    bodyExtras={
      <>
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
          Entra a tu pedido y dinos si todavía lo quieres: puedes confirmar que pasarás por él o
          cancelarlo si ya no te interesa.
        </Text>
        <Text
          style={{
            fontSize: '14px',
            color: '#78716c',
            margin: '0 0 8px 0',
            lineHeight: '1.6',
          }}
        >
          Si no tenemos noticias tuyas, podremos cancelarlo para regresar la mercancía al anaquel.
        </Text>
      </>
    }
  />
);
