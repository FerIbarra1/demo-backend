import * as React from 'react';
import { Heading, Hr, Section, Text } from '@react-email/components';
import { EmailLayout } from './Layout';
import { ItemList, ItemTotal } from './ItemList';
import { PedidoEmailData, folioVisible, rotuloDelNumero } from '../mail.templates';

export interface PedidoEmailShellProps {
  preview: string;
  title: string;
  greeting: string;
  pedido: PedidoEmailData;
  pedidoUrl: string;
  bodyExtras?: React.ReactNode;
  ctaLabel?: string;
  logoUrl: string;
  frontendUrl: string;
  /**
   * Oculta la lista de productos. Los correos de pago por transferencia son sobre DINERO (monto,
   * cuenta, referencia): la lista de productos los alarga y repite el total.
   */
  ocultarProductos?: boolean;
}

// Paleta sincronizada con el Layout y globals.css del front.
const colors = {
  backgroundSubtle: '#f5f3f0',
  backgroundElevated: '#ffffff',
  borderSubtle: '#f5f5f4',
  border: '#e7e5e4',
  foreground: '#1c1917',
  foregroundMuted: '#78716c',
  accent: '#6ebd50',
};

const sectionTitle = {
  fontSize: '11px',
  fontWeight: '600' as const,
  color: colors.foregroundMuted,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  margin: '0 0 12px 0',
};

const labelValue = {
  fontSize: '14px',
  color: colors.foreground,
  margin: '6px 0',
  lineHeight: '1.5',
};

const fmtDate = (d: Date | string) => {
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
};

const ctaStyle = {
  backgroundColor: colors.foreground,
  borderRadius: '8px',
  color: colors.backgroundElevated,
  fontSize: '14px',
  fontWeight: '600' as const,
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'inline-block',
  padding: '14px 32px',
  letterSpacing: '0.01em',
};

export const PedidoEmailShell = ({
  preview,
  title,
  greeting,
  pedido,
  pedidoUrl,
  bodyExtras,
  ctaLabel = 'Ver mi pedido',
  logoUrl,
  frontendUrl,
  ocultarProductos = false,
}: PedidoEmailShellProps) => (
  <EmailLayout preview={preview} logoUrl={logoUrl} frontendUrl={frontendUrl}>
    <Heading
      style={{
        fontSize: '24px',
        fontWeight: '500',
        color: colors.foreground,
        margin: '0 0 16px 0',
        fontFamily: '"Playfair Display", Georgia, serif',
        letterSpacing: '-0.01em',
        lineHeight: '1.2',
      }}
    >
      {title}
    </Heading>
    <Text
      style={{
        margin: '0 0 28px 0',
        fontSize: '15px',
        color: colors.foreground,
        lineHeight: '1.6',
      }}
    >
      {greeting}
    </Text>

    <Section
      style={{
        backgroundColor: colors.backgroundSubtle,
        borderRadius: '10px',
        padding: '20px 24px',
        margin: '0 0 28px 0',
        border: `1px solid ${colors.borderSubtle}`,
      }}
    >
      <Text style={sectionTitle}>Resumen del pedido</Text>
      {/* Un solo lugar para el folio (el título y el saludo no lo repiten). Sin fila de "Estado":
          el título de cada correo ya dice qué pasó, y repetirlo aquí hacía que el mismo dato
          saliera dos o tres veces. */}
      <Text style={labelValue}>
        <strong>{rotuloDelNumero(pedido)}:</strong> {folioVisible(pedido)}
      </Text>
      {/* Solo el primer correo con folio: une el número que el cliente ya conoce (el de su confirmación) con el nuevo. */}
      {pedido.referenciaWeb ? (
        <Text style={labelValue}>
          <strong>Pedido en línea:</strong> {pedido.referenciaWeb} (el número de tu correo de confirmación)
        </Text>
      ) : null}
      <Text style={labelValue}>
        <strong>Fecha del pedido:</strong> {fmtDate(pedido.fechaPedido)}
      </Text>
      {pedido.tiendaNombre ? (
        <Text style={labelValue}>
          <strong>Tienda:</strong> {pedido.tiendaNombre}
        </Text>
      ) : null}
      {pedido.paqueteria ? (
        <Text style={labelValue}>
          <strong>Paquetería:</strong> {pedido.paqueteria}
        </Text>
      ) : null}
    </Section>

    {!ocultarProductos && pedido.items && pedido.items.length > 0 ? (
      <Section style={{ margin: '0 0 8px 0' }}>
        <Text style={sectionTitle}>Productos</Text>
        <ItemList items={pedido.items} />
        <ItemTotal label="Total" amount={pedido.total} />
      </Section>
    ) : null}

    {bodyExtras}

    <Section style={{ textAlign: 'center', margin: '32px 0 8px 0' }}>
      <a href={pedidoUrl} style={ctaStyle}>
        {ctaLabel}
      </a>
    </Section>

    <Hr style={{ borderColor: colors.borderSubtle, margin: '32px 0 16px 0' }} />
    <Text style={{ fontSize: '12px', color: colors.foregroundMuted, lineHeight: '1.5' }}>
      {/* El teléfono se enviaba desde el servicio pero ninguna plantilla lo
          mostraba: el cliente leía "escríbenos a la tienda" sin ningún dato
          de contacto. */}
      {pedido.tiendaNombre && pedido.tiendaTelefono ? (
        <>
          ¿Dudas con tu pedido? Llama a {pedido.tiendaNombre} al{' '}
          <strong>{pedido.tiendaTelefono}</strong>, o responde directamente a este correo.
        </>
      ) : (
        <>
          Si tienes dudas con tu pedido, responde directamente a este correo y con gusto te
          ayudamos.
        </>
      )}
    </Text>
  </EmailLayout>
);
