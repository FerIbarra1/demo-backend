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
  header: {
    backgroundColor: colors.background,
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
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.header}>
            {logoUrl ? (
              <Img
                src={logoUrl}
                width="220"
                height="auto"
                alt="Punto Textil Mayoreo"
                style={styles.logo}
              />
            ) : (
              <Text style={styles.brandText}>Punto Textil Mayoreo</Text>
            )}
          </Section>
          <Section style={styles.content}>{children}</Section>
          <Hr style={{ borderColor: colors.borderSubtle, margin: 0 }} />
          <Section style={styles.footer}>
            <Text>
              © {year} Punto Textil Mayoreo
              <br />
              <Link href={frontendUrl} style={styles.footerLink}>
                Visitar sitio
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};
