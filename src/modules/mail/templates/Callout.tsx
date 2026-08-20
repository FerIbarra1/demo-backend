import * as React from 'react';
import { Section, Text } from '@react-email/components';

// Paleta warm premium del front (sincronizada con globals.css).
const colors = {
  backgroundSubtle: '#f5f3f0',
  backgroundElevated: '#ffffff',
  border: '#e7e5e4',
  borderSubtle: '#f5f5f4',
  foreground: '#1c1917',
  foregroundMuted: '#78716c',
  // Variantes — el `borderLeft` siempre es un color neutro de la paleta
  // (`foreground`) para mantener coherencia; el fondo tinted es la pista
  // semántica.
  warningBg: '#fef3c7',
  warningText: '#92400e',
  successBg: '#ecfdf5',
  successText: '#065f46',
  dangerBg: '#fef2f2',
  dangerText: '#991b1b',
};

export type CalloutVariant = 'info' | 'warning' | 'success' | 'danger';

export interface CalloutProps {
  variant?: CalloutVariant;
  label?: string;
  children: React.ReactNode;
}

const variantStyles: Record<
  CalloutVariant,
  { backgroundColor: string; labelColor: string; bodyColor: string; accent: string }
> = {
  info: {
    backgroundColor: colors.backgroundSubtle,
    labelColor: colors.foregroundMuted,
    bodyColor: colors.foreground,
    accent: colors.foreground,
  },
  warning: {
    backgroundColor: colors.warningBg,
    labelColor: colors.warningText,
    bodyColor: colors.foreground,
    accent: colors.warningText,
  },
  success: {
    backgroundColor: colors.successBg,
    labelColor: colors.successText,
    bodyColor: colors.foreground,
    accent: colors.successText,
  },
  danger: {
    backgroundColor: colors.dangerBg,
    labelColor: colors.dangerText,
    bodyColor: colors.foreground,
    accent: colors.dangerText,
  },
};

/**
 * Bloque de destaque con borde lateral + fondo tintado. Usado en los
 * emails de pedido para mensajes del bodeguero, motivos de cancelación,
 * direcciones de envío, etc. Variante default `info` (neutro).
 */
export const Callout: React.FC<CalloutProps> = ({
  variant = 'info',
  label,
  children,
}) => {
  const s = variantStyles[variant];
  return (
    <Section
      style={{
        backgroundColor: s.backgroundColor,
        borderLeft: `3px solid ${s.accent}`,
        padding: '16px 20px',
        borderRadius: '8px',
        margin: '0 0 24px 0',
      }}
    >
      {label ? (
        <Text
          style={{
            fontSize: '11px',
            color: s.labelColor,
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            margin: '0 0 8px 0',
          }}
        >
          {label}
        </Text>
      ) : null}
      <Text
        style={{
          fontSize: '14px',
          color: s.bodyColor,
          margin: 0,
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap' as const,
        }}
      >
        {children}
      </Text>
    </Section>
  );
};
