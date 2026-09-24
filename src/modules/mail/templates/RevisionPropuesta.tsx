import * as React from 'react';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Text } from '@react-email/components';
import { Callout } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

/**
 * Origen de la propuesta. El mismo template sirve a tres eventos distintos, y
 * el texto debe decir quién escribe: antes hablaba siempre de "el bodeguero",
 * así que un cliente negociando con un asesor de ventas leía que su propuesta
 * venía de bodega.
 */
export type OrigenPropuesta = 'bodega' | 'ventas' | 'asesor';

export interface RevisionPropuestaProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  mensajeBodeguero?: string;
  origen?: OrigenPropuesta;
  logoUrl: string;
  frontendUrl: string;
}

const TEXTOS: Record<
  OrigenPropuesta,
  { preview: string; title: string; greeting: string; label: string; cuerpo: string }
> = {
  bodega: {
    preview: 'Nuestro equipo de bodega tiene una propuesta para tu pedido',
    title: 'Tu pedido tiene cambios propuestos',
    greeting:
      'Nuestro equipo de bodega terminó de revisar tu pedido y encontró algo que queremos confirmar contigo antes de continuar.',
    label: 'Mensaje de bodega',
    cuerpo:
      'Revisa el detalle para ver exactamente qué se ajustó (sustituciones, cantidades o piezas no disponibles) y, si estás de acuerdo, confírmalo. Si prefieres otra opción, respóndenos desde el chat del pedido o pide hablar con un asesor de ventas.',
  },
  ventas: {
    preview: 'Tu asesor de ventas tiene una propuesta para tu pedido',
    title: 'Tu asesor de ventas te propone un ajuste',
    greeting:
      'Tu asesor de ventas revisó tu pedido y preparó una propuesta para que puedas continuar con tu compra.',
    label: 'Mensaje de tu asesor',
    cuerpo:
      'Revisa el detalle de la propuesta y, si estás de acuerdo, confírmala. Si quieres ajustar algo, responde directamente desde el chat del pedido — tu asesor sigue atendiéndote.',
  },
  asesor: {
    preview: 'Un asesor de ventas atenderá tu pedido',
    title: 'Un asesor de ventas tomará tu pedido',
    greeting:
      'Recibimos tu solicitud. Un asesor de ventas revisará tu pedido y se pondrá en contacto contigo para ayudarte a resolverlo.',
    label: 'Tu solicitud',
    cuerpo:
      'Puedes seguir la conversación en tiempo real desde el chat del pedido. Te avisaremos por correo en cuanto tu asesor tenga una propuesta lista.',
  },
};

export const RevisionPropuesta = ({
  pedido,
  pedidoUrl,
  mensajeBodeguero,
  origen = 'bodega',
  logoUrl,
  frontendUrl,
}: RevisionPropuestaProps) => {
  const t = TEXTOS[origen];
  return (
    <PedidoEmailShell
      preview={`${t.preview} ${folioVisible(pedido)}`}
      title={t.title}
      greeting={`Hola, ${pedido.clienteNombre}. ${t.greeting}`}
      pedido={pedido}
      pedidoUrl={pedidoUrl}
      ctaLabel="Revisar y responder"
      logoUrl={logoUrl}
      frontendUrl={frontendUrl}
      bodyExtras={
        <>
          {mensajeBodeguero ? (
            <Callout variant="warning" label={t.label}>
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
            {t.cuerpo}
          </Text>
        </>
      }
    />
  );
};
