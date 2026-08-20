import * as React from 'react';
import { Img, Section, Text } from '@react-email/components';
import { ItemPedidoSnapshot } from '../mail.templates';

// Paleta sincronizada con demo-frontend (shadcn globals.css). Ver Layout.tsx.
const colors = {
  backgroundSubtle: '#f5f3f0',
  border: '#e7e5e4',
  borderSubtle: '#f5f5f4',
  foreground: '#1c1917',
  foregroundMuted: '#78716c',
  foregroundSubtle: '#a8a29e',
};

const format = (n: number) =>
  new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(Number.isFinite(n) ? n : 0);

const fmtMoney = (v: number | string | { toNumber?: () => number; toString: () => string }) => {
  if (typeof v === 'number') return format(v);
  if (typeof v === 'string') return format(parseFloat(v));
  if (typeof v?.toNumber === 'function') return format(v.toNumber());
  return format(parseFloat(v.toString()));
};

const cell = {
  fontFamily:
    '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: '14px',
  color: colors.foreground,
  padding: '14px 0',
  borderBottom: `1px solid ${colors.borderSubtle}`,
  verticalAlign: 'top' as const,
};

const nombre = {
  fontSize: '14px',
  fontWeight: '600' as const,
  color: colors.foreground,
  margin: '0 0 2px 0',
  lineHeight: '1.3',
};

const variante = {
  fontSize: '12px',
  color: colors.foregroundMuted,
  margin: 0,
  lineHeight: '1.4',
};

const cantidad = {
  fontSize: '13px',
  color: colors.foregroundMuted,
  textAlign: 'center' as const,
  padding: '14px 8px',
  borderBottom: `1px solid ${colors.borderSubtle}`,
  verticalAlign: 'top' as const,
  fontWeight: '500' as const,
};

const subtotal = {
  fontSize: '14px',
  fontWeight: '600' as const,
  color: colors.foreground,
  textAlign: 'right' as const,
  padding: '14px 0 14px 12px',
  borderBottom: `1px solid ${colors.borderSubtle}`,
  verticalAlign: 'top' as const,
  fontVariantNumeric: 'tabular-nums' as const,
};

const imgWrap = {
  width: '64px',
  height: '64px',
  backgroundColor: colors.backgroundSubtle,
  borderRadius: '8px',
  overflow: 'hidden' as const,
  flexShrink: 0,
  marginRight: '14px',
};

const placeholder = {
  width: '64px',
  height: '64px',
  backgroundColor: colors.backgroundSubtle,
  borderRadius: '8px',
  display: 'flex',
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  fontSize: '20px',
  color: colors.foregroundSubtle,
  marginRight: '14px',
  flexShrink: 0,
};

export interface ItemListProps {
  items: ItemPedidoSnapshot[];
}

/**
 * Lista de productos del pedido con imagen, nombre, variante, cantidad y
 * subtotal. Estilo "carrito de marca grande" (Aesop, Stripe, etc.) — cada
 * item es una fila con thumbnail 64px a la izquierda, dos líneas de texto
 * (nombre + variante "Talla L · Azul"), cantidad centrada y subtotal
 * alineado a la derecha con tipografía monoespaciada para que las cifras
 * alineen verticalmente.
 *
 * Si la imagen no está disponible, cae a un placeholder con la inicial
 * del nombre del producto sobre fondo `backgroundSubtle`.
 */
export const ItemList: React.FC<ItemListProps> = ({ items }) => {
  if (items.length === 0) return null;

  return (
    <Section style={{ margin: '0 0 8px 0' }}>
      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={0}
        style={{ width: '100%', borderCollapse: 'collapse' as const }}
      >
        <tbody>
          {items.map((it, i) => {
            const inicial = it.productoNombre?.charAt(0)?.toUpperCase() ?? '·';
            return (
              <tr key={i}>
                <td
                  style={{
                    ...cell,
                    width: '78px',
                    paddingRight: '4px',
                    paddingTop: i === 0 ? '4px' : cell.padding,
                  }}
                >
                  {it.imagenUrl ? (
                    <Img
                      src={it.imagenUrl}
                      width="64"
                      height="64"
                      alt={it.productoNombre}
                      style={{
                        width: '64px',
                        height: '64px',
                        objectFit: 'cover' as const,
                        borderRadius: '8px',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <div style={placeholder}>{inicial}</div>
                  )}
                </td>
                <td style={cell}>
                  <Text style={nombre}>{it.productoNombre}</Text>
                  <Text style={variante}>
                    Talla {it.tallaNombre} · {it.colorNombre}
                  </Text>
                </td>
                <td style={cantidad}>×{it.cantidad}</td>
                <td style={subtotal}>{fmtMoney(it.subtotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
};

export interface ItemTotalProps {
  label: string;
  amount: number | string | { toNumber?: () => number; toString: () => string };
  emphasize?: boolean;
}

export const ItemTotal: React.FC<ItemTotalProps> = ({ label, amount, emphasize = true }) => (
  <table
    role="presentation"
    cellPadding={0}
    cellSpacing={0}
    style={{ width: '100%', borderCollapse: 'collapse' as const, margin: '8px 0 0 0' }}
  >
    <tr>
      <td
        style={{
          fontSize: emphasize ? '15px' : '13px',
          fontWeight: emphasize ? '600' : '400',
          color: emphasize ? colors.foreground : colors.foregroundMuted,
          padding: emphasize ? '14px 0 4px 0' : '4px 0',
          textAlign: 'right' as const,
        }}
      >
        {label}
      </td>
      <td
        style={{
          fontSize: emphasize ? '18px' : '13px',
          fontWeight: emphasize ? '700' : '400',
          color: emphasize ? colors.foreground : colors.foregroundMuted,
          padding: emphasize ? '14px 0 4px 12px' : '4px 0 4px 12px',
          textAlign: 'right' as const,
          fontVariantNumeric: 'tabular-nums' as const,
          width: '110px',
        }}
      >
        {fmtMoney(amount)}
      </td>
    </tr>
  </table>
);
