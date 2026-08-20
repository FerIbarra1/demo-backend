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
      está lista para que empieces a explorar nuestro catálogo y hacer tus
      pedidos.
    </Text>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 12px 0',
        fontWeight: '500',
      }}
    >
      Algunas cosas que puedes hacer ahora:
    </Text>
    <div style={{ margin: '0 0 8px 16px' }}>
      <Text style={tip}>Explorar el catálogo de productos disponibles</Text>
      <Text style={tip}>
        Armar tu pedido y elegir entre envío a domicilio, recogida en tienda
        o comprar en uno de nuestros kioskos
      </Text>
      <Text style={tip}>
        Dar seguimiento a tus pedidos desde tu cuenta, en tiempo real
      </Text>
      <Text style={tip}>
        Guardar tus productos favoritos para encontrarlos rápido
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
      Si no creaste esta cuenta, puedes ignorar este correo.
    </Text>
  </EmailLayout>
);
