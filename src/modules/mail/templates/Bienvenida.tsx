import * as React from 'react';
import { Heading, Text } from '@react-email/components';
import { EmailLayout } from './Layout';
import { Button } from './Button';

export interface BienvenidaProps {
  nombre: string;
  logoUrl: string;
  frontendUrl: string;
}

const tip = {
  fontSize: '14px',
  color: '#1c1917',
  margin: '6px 0',
  paddingLeft: '4px',
  lineHeight: '1.5',
};

export const Bienvenida = ({ nombre, logoUrl, frontendUrl }: BienvenidaProps) => (
  <EmailLayout
    preview={`¡Bienvenido a Punto Textil Mayoreo, ${nombre}! Tu cuenta está lista`}
    logoUrl={logoUrl}
    frontendUrl={frontendUrl}
  >
    <Heading
      style={{
        fontSize: '24px',
        fontWeight: '500',
        color: '#1c1917',
        margin: '0 0 16px 0',
        fontFamily: '"Playfair Display", Georgia, serif',
        letterSpacing: '-0.01em',
        lineHeight: '1.2',
      }}
    >
      ¡Hola, {nombre}!
    </Heading>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 24px 0',
        lineHeight: '1.6',
      }}
    >
      Te damos la bienvenida a <strong>Punto Textil Mayoreo</strong>. Tu cuenta
      ya está activa para que consultes precios de mayoreo y armes tus pedidos
      en línea.
    </Text>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 12px 0',
        fontWeight: '500',
      }}
    >
      Con tu cuenta puedes:
    </Text>
    <div style={{ margin: '0 0 8px 16px' }}>
      <Text style={tip}>
        Consultar el catálogo completo con precios de mayoreo por talla y color
      </Text>
      <Text style={tip}>
        Armar tu pedido y elegir entrega a domicilio o recoger en cualquiera de
        nuestras sucursales
      </Text>
      <Text style={tip}>
        Seguir el avance de cada pedido en tiempo real: revisión de bodega,
        pago, envío y entrega
      </Text>
      <Text style={tip}>
        Guardar tus productos frecuentes para volver a pedirlos en segundos
      </Text>
    </div>
    <Button href={`${frontendUrl}/catalogo`}>Ver catálogo</Button>
    <Text
      style={{
        fontSize: '12px',
        color: '#78716c',
        textAlign: 'center',
        margin: '24px 0 0 0',
        lineHeight: '1.5',
      }}
    >
      ¿Necesitas factura o tienes dudas sobre precios y mínimos de compra?
      Responde a este correo y te atendemos.
    </Text>
  </EmailLayout>
);
