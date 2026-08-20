import * as React from 'react';
import { Section } from '@react-email/components';

const colors = {
  foreground: '#1c1917',
  backgroundElevated: '#ffffff',
  border: '#e7e5e4',
  foregroundMuted: '#78716c',
};

export type ButtonVariant = 'primary' | 'secondary';

const variantStyles: Record<
  ButtonVariant,
  { backgroundColor: string; color: string; border?: string }
> = {
  primary: {
    backgroundColor: colors.foreground,
    color: colors.backgroundElevated,
  },
  secondary: {
    backgroundColor: colors.backgroundElevated,
    color: colors.foreground,
    border: `1px solid ${colors.border}`,
  },
};

export interface ButtonProps {
  href: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
}

export const Button: React.FC<ButtonProps> = ({ href, children, variant = 'primary' }) => {
  const s = variantStyles[variant];
  return (
    <Section style={{ textAlign: 'center', margin: '24px 0 8px 0' }}>
      <a
        href={href}
        style={{
          backgroundColor: s.backgroundColor,
          color: s.color,
          border: s.border,
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: '600',
          textDecoration: 'none',
          textAlign: 'center',
          display: 'inline-block',
          padding: '14px 32px',
          letterSpacing: '0.01em',
          fontFamily:
            '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        {children}
      </a>
    </Section>
  );
};
