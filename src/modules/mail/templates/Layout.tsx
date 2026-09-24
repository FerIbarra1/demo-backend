import * as React from 'react';
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface EmailLayoutProps {
  preview: string;
  logoUrl: string;
  frontendUrl: string;
  children: React.ReactNode;
}

// Paleta sincronizada con demo-frontend (shadcn globals.css — design system
// "Warm Premium"). Si cambian los tokens del front, actualizar acá.
const colors = {
  background: '#faf9f7',
  backgroundElevated: '#ffffff',
  backgroundSubtle: '#f5f3f0',
  foreground: '#1c1917',
  foregroundMuted: '#78716c',
  border: '#e7e5e4',
  borderSubtle: '#f5f5f4',
  accent: '#6ebd50',
  accentHover: '#467832',
  destructive: '#c45c4a',
};

const styles = {
  body: {
    backgroundColor: colors.background,
    fontFamily:
      '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    margin: 0,
    padding: 0,
    WebkitFontSmoothing: 'antialiased' as const,
  },
  container: {
    maxWidth: '600px',
    backgroundColor: colors.backgroundElevated,
    margin: '0 auto',
    borderRadius: '12px',
    overflow: 'hidden' as const,
    boxShadow: '0 4px 20px -2px rgba(0,0,0,0.05)',
  },
  // El header va SIEMPRE en blanco. El logo de PTM es oscuro sobre blanco, así
  // que si el cliente de correo invierte los colores en modo oscuro el fondo se
  // vuelve negro y el logo desaparece. Ver `colorSchemeLightOnly` abajo: además
  // del color explícito, se le dice al cliente que no invierta.
  header: {
    backgroundColor: '#ffffff',
    padding: '40px 32px 32px',
    textAlign: 'center' as const,
    borderBottom: `1px solid ${colors.borderSubtle}`,
  },
  logo: {
    margin: '0 auto',
    display: 'block',
  },
  brandText: {
    color: colors.foreground,
    fontSize: '28px',
    fontWeight: '500' as const,
    letterSpacing: '0.5px',
    margin: '12px 0 0 0',
    fontFamily: '"Playfair Display", Georgia, serif',
  },
  content: {
    padding: '40px 32px',
    color: colors.foreground,
    fontSize: '15px',
    lineHeight: '1.6',
  },
  footer: {
    padding: '24px 32px',
    textAlign: 'center' as const,
    color: colors.foregroundMuted,
    fontSize: '12px',
    lineHeight: '1.6',
  },
  footerLink: {
    color: colors.foreground,
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
};

export const EmailLayout = ({
  preview,
  logoUrl,
  frontendUrl,
  children,
}: EmailLayoutProps) => {
  const year = new Date().getFullYear();
  return (
    <Html>
      <Head>
        {/* Modo oscuro: se declara que el correo es sólo claro.
            Sin esto, Gmail/Outlook invierten los fondos y el header del logo
            (diseñado oscuro sobre blanco) se vuelve negro y el logo desaparece.
            Los clientes que respetan la declaración mantienen el diseño tal
            como se ve en claro. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <style>{`
          :root { color-scheme: light; supported-color-schemes: light; }
          /* Refuerzo para clientes que invierten por su cuenta: el header
             mantiene su fondo blanco aunque el resto se oscurezca. */
          .ptm-header { background-color: #ffffff !important; }
          .ptm-header img { background-color: #ffffff !important; }
        `}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section className="ptm-header" style={styles.header}>
            {logoUrl ? (
              <Img
                src={logoUrl}
                width="220"
                height="auto"
                alt="Punto Textil Mayoreo"
                className="ptm-header"
                style={styles.logo}
              />
            ) : (
              <Text style={styles.brandText}>Punto Textil Mayoreo</Text>
            )}
          </Section>
          <Section style={styles.content}>{children}</Section>
          <Hr style={{ borderColor: colors.borderSubtle, margin: 0 }} />
          <Section style={styles.footer}>
            <Text style={{ margin: '0 0 8px 0' }}>
              © {year} Punto Textil Mayoreo
            </Text>
            <Text style={{ margin: '0 0 8px 0' }}>
              <Link href={`${frontendUrl}/pedidos`} style={styles.footerLink}>
                Mis pedidos
              </Link>
              {' · '}
              <Link href={`${frontendUrl}/catalogo`} style={styles.footerLink}>
                Catálogo
              </Link>
              {' · '}
              <Link href={frontendUrl} style={styles.footerLink}>
                Sitio
              </Link>
            </Text>
            <Text style={{ margin: 0, fontSize: '11px' }}>
              Recibes este correo porque hiciste un pedido en Punto Textil
              Mayoreo. Si tienes dudas sobre tu cuenta o tus pedidos, responde a
              este correo.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};
