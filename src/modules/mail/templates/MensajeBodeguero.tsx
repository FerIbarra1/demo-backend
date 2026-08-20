import * as React from 'react';
import { Heading, Section, Text } from '@react-email/components';
import { EmailLayout } from './Layout';
import {
  parsePropuestaContenido,
  resumenPropuesta,
  type ItemPropuestaJson,
} from '../propuesta';
import { PedidoEmailData } from '../mail.templates';

export interface MensajeBodegueroProps {
  pedido: PedidoEmailData;
  pedidoUrl: string;
  mensaje: string;
  nombreBodeguero: string;
  logoUrl: string;
  frontendUrl: string;
}

const colors = {
  backgroundSubtle: '#f5f3f0',
  backgroundElevated: '#ffffff',
  borderSubtle: '#f5f5f4',
  border: '#e7e5e4',
  foreground: '#1c1917',
  foregroundMuted: '#78716c',
  foregroundSubtle: '#a8a29e',
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
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(Number.isFinite(n) ? n : 0);

const TIPO_LABEL: Record<ItemPropuestaJson['tipo'], { label: string; bg: string; color: string }> = {
  completo: { label: 'OK', bg: '#dcfce7', color: '#166534' },
  parcial: { label: 'Parcial', bg: '#fef3c7', color: '#92400e' },
  cambio: { label: 'Cambio', bg: '#dbeafe', color: '#1e40af' },
  'no-disponible': { label: 'No disp.', bg: '#fee2e2', color: '#991b1b' },
  agregado: { label: 'Nuevo', bg: '#ede9fe', color: '#5b21b6' },
};

export const MensajeBodeguero = ({
  pedido,
  pedidoUrl,
  mensaje,
  nombreBodeguero,
  logoUrl,
  frontendUrl,
}: MensajeBodegueroProps) => {
  const parsed = parsePropuestaContenido(mensaje);
  const textoLibre = parsed?.textoLibre || '';

  return (
    <EmailLayout
      preview={`${nombreBodeguero} te ha enviado un mensaje sobre tu pedido ${pedido.numeroPedido}`}
      logoUrl={logoUrl}
      frontendUrl={frontendUrl}
    >
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
        Tienes un mensaje de bodega
      </Heading>
      <Text
        style={{
          fontSize: '15px',
          color: colors.foreground,
          margin: '0 0 24px 0',
          lineHeight: '1.6',
        }}
      >
        Hola, {pedido.clienteNombre}. {nombreBodeguero}, del equipo de bodega,
        te ha escrito sobre tu pedido <strong>{pedido.numeroPedido}</strong>.
      </Text>

      <Section
        style={{
          backgroundColor: colors.backgroundSubtle,
          borderLeft: `3px solid ${colors.foreground}`,
          padding: '20px 24px',
          borderRadius: '8px',
          margin: '0 0 28px 0',
        }}
      >
        <Text
          style={{
            fontSize: '11px',
            color: colors.foregroundMuted,
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            margin: '0 0 12px 0',
          }}
        >
          {nombreBodeguero} propone:
        </Text>

        {parsed ? (
          <>
            {textoLibre ? (
              <Text
                style={{
                  fontSize: '15px',
                  color: colors.foreground,
                  margin: '0 0 16px 0',
                  whiteSpace: 'pre-wrap',
                  lineHeight: '1.6',
                }}
              >
                {textoLibre}
              </Text>
            ) : null}
            <PropuestaTabla propuesta={parsed.propuesta} />
            <Text
              style={{
                fontSize: '13px',
                color: colors.foreground,
                margin: '16px 0 0 0',
                fontWeight: '600',
              }}
            >
              {resumenPropuesta(parsed.propuesta)}
            </Text>
          </>
        ) : (
          <Text
            style={{
              fontSize: '15px',
              color: colors.foreground,
              margin: 0,
              whiteSpace: 'pre-wrap',
              lineHeight: '1.6',
            }}
          >
            {mensaje}
          </Text>
        )}
      </Section>

      <Text
        style={{
          fontSize: '14px',
          color: colors.foregroundMuted,
          margin: '0 0 28px 0',
          lineHeight: '1.6',
        }}
      >
        Puedes responder directamente desde el chat del pedido. Te avisaremos
        por correo únicamente cuando sea la primera vez que el bodeguero te
        escribe — el resto de la conversación la puedes seguir en tiempo
        real dentro de la pagina.
      </Text>

      <Section style={{ textAlign: 'center', margin: '8px 0' }}>
        <a href={pedidoUrl} style={ctaStyle}>
          Abrir mi pedido
        </a>
      </Section>
    </EmailLayout>
  );
};

interface PropuestaTablaProps {
  propuesta: { items: ItemPropuestaJson[]; total: number };
}

const PropuestaTabla: React.FC<PropuestaTablaProps> = ({ propuesta }) => {
  const headerCell = {
    fontSize: '11px',
    fontWeight: '600' as const,
    color: colors.foregroundMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    padding: '10px 8px',
    borderBottom: `1px solid ${colors.border}`,
  } as const;

  const cell = {
    fontSize: '13px',
    color: colors.foreground,
    padding: '12px 8px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
    verticalAlign: 'top' as const,
    lineHeight: '1.5',
  } as const;

  const badge = (tipo: ItemPropuestaJson['tipo']) => {
    const t = TIPO_LABEL[tipo];
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          borderRadius: '12px',
          fontSize: '11px',
          fontWeight: '600',
          backgroundColor: t.bg,
          color: t.color,
          letterSpacing: '0.02em',
        }}
      >
        {t.label}
      </span>
    );
  };

  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ width: '100%', borderCollapse: 'collapse' as const }}
    >
      <thead>
        <tr>
          <th style={{ ...headerCell, textAlign: 'left' as const }}>Producto</th>
          <th style={{ ...headerCell, textAlign: 'center' as const, width: '80px' }}>
            Tipo
          </th>
          <th style={{ ...headerCell, textAlign: 'right' as const, width: '50px' }}>
            Cant.
          </th>
          <th style={{ ...headerCell, textAlign: 'right' as const, width: '90px' }}>
            Subtotal
          </th>
        </tr>
      </thead>
      <tbody>
        {propuesta.items.map((it, i) => {
          const cantidadFinal = it.cantidadNueva ?? it.cantidad;
          const subtotalFinal = it.subtotalNuevo ?? it.subtotal;
          return (
            <tr key={i}>
              <td style={cell}>
                <div style={{ fontWeight: '600', color: colors.foreground }}>{it.producto}</div>
                <div style={{ fontSize: '12px', color: colors.foregroundMuted, marginTop: '2px' }}>
                  {it.variante}
                </div>
                {it.tipo === 'cambio' ? (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#1e40af',
                      marginTop: '8px',
                      padding: '8px 10px',
                      backgroundColor: '#eff6ff',
                      borderRadius: '6px',
                      lineHeight: '1.5',
                    }}
                  >
                    <div>
                      <span style={{ color: colors.foregroundMuted }}>Antes:</span>{' '}
                      {it.cantidadOriginal}× {it.varianteOriginal}
                    </div>
                    <div style={{ marginTop: '2px' }}>
                      <span style={{ color: colors.foregroundMuted }}>Ahora:</span>{' '}
                      {it.cantidadNueva}× {it.varianteNueva}
                    </div>
                  </div>
                ) : null}
              </td>
              <td style={{ ...cell, textAlign: 'center' as const }}>{badge(it.tipo)}</td>
              <td
                style={{
                  ...cell,
                  textAlign: 'right' as const,
                  fontWeight: '500',
                  fontVariantNumeric: 'tabular-nums' as const,
                }}
              >
                {cantidadFinal}
              </td>
              <td
                style={{
                  ...cell,
                  textAlign: 'right' as const,
                  fontWeight: '600',
                  fontVariantNumeric: 'tabular-nums' as const,
                }}
              >
                {fmtMoney(Number(subtotalFinal))}
              </td>
            </tr>
          );
        })}
        <tr>
          <td
            colSpan={3}
            style={{
              ...cell,
              textAlign: 'right' as const,
              fontWeight: '700',
              fontSize: '14px',
              color: colors.foreground,
              borderBottom: 'none',
              paddingTop: '16px',
            }}
          >
            Total
          </td>
          <td
            style={{
              ...cell,
              textAlign: 'right' as const,
              fontWeight: '700',
              fontSize: '16px',
              color: colors.foreground,
              borderBottom: 'none',
              paddingTop: '16px',
              fontVariantNumeric: 'tabular-nums' as const,
            }}
          >
            {fmtMoney(propuesta.total)}
          </td>
        </tr>
      </tbody>
    </table>
  );
};
