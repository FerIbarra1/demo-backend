import * as React from 'react';
import { Heading, Section, Text } from '@react-email/components';
import { EmailLayout } from './Layout';
import { Button } from './Button';

export interface ResetPasswordProps {
  nombre: string;
  resetUrl: string;
  expiresInMin: number;
  logoUrl: string;
  frontendUrl: string;
}

export const ResetPassword = ({
  nombre,
  resetUrl,
  expiresInMin,
  logoUrl,
  frontendUrl,
}: ResetPasswordProps) => (
  <EmailLayout
    preview="Recupera el acceso a tu cuenta de Punto Textil Mayoreo"
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
      Recupera tu contraseña
    </Heading>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 12px 0',
        lineHeight: '1.6',
      }}
    >
      Hola, {nombre}.
    </Text>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 24px 0',
        lineHeight: '1.6',
      }}
    >
      Recibimos una solicitud para restablecer la contraseña de tu cuenta. Si
      no fuiste tú, puedes ignorar este correo — tu contraseña seguirá igual.
    </Text>
    <Text
      style={{
        fontSize: '15px',
        color: '#1c1917',
        margin: '0 0 8px 0',
        lineHeight: '1.6',
      }}
    >
      Para crear una nueva contraseña haz clic en el siguiente botón. Este
      enlace expira en <strong>{expiresInMin} minutos</strong> y sólo puede
      usarse una vez.
    </Text>
    <Button href={resetUrl}>Restablecer mi contraseña</Button>
    <Text
      style={{
        fontSize: '13px',
        color: '#78716c',
        margin: '32px 0 0 0',
        lineHeight: '1.5',
      }}
    >
      Si el botón no funciona, copia y pega este enlace en tu navegador:
    </Text>
    <Text
      style={{
        fontSize: '12px',
        color: '#1c1917',
        wordBreak: 'break-all' as const,
        backgroundColor: '#f5f3f0',
        padding: '12px 14px',
        borderRadius: '8px',
        margin: '8px 0',
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        lineHeight: '1.4',
      }}
    >
      {resetUrl}
    </Text>
  </EmailLayout>
);
