import * as React from 'react';
import { Section, Text } from '@react-email/components';
import { PedidoEmailShell } from './PedidoEmailShell';
import { Callout, type CalloutVariant } from './Callout';
import { PedidoEmailData, folioVisible } from '../mail.templates';

export type VarianteTransferencia =
  | 'INSTRUCCIONES'
  | 'COMPROBANTE_RECIBIDO'
  | 'VERIFICADA'
  | 'RECHAZADA'
  | 'POR_VENCER'
  | 'REEMBOLSADA';

export interface LineaCorreo {
  etiqueta: string;
  /** Lo que se muestra (la CLABE va agrupada). */
  mostrar: string;
}

export interface TransferenciaPagoProps {
  variante: VarianteTransferencia;
  pedido: PedidoEmailData;
  pedidoUrl: string;
  logoUrl: string;
  frontendUrl: string;
  /** Datos para transferir (solo INSTRUCCIONES / POR_VENCER). */
  lineas?: LineaCorreo[];
  /** Avisos que acompañan a los datos. */
  notas?: string[];
  /** Motivo (RECHAZADA) o datos del reembolso (REEMBOLSADA). */
  detalle?: string;
}

const colors = { foreground: '#1c1917', muted: '#78716c', subtle: '#f5f3f0', border: '#e7e5e4' };

const parrafo = {
  fontSize: '14px',
  color: colors.foreground,
  margin: '0 0 8px 0',
  lineHeight: '1.6',
};

interface Textos {
  titulo: string;
  saludo: (folio: string, nombre: string) => string;
  cta: string;
  callout?: { variante: CalloutVariant; etiqueta: string };
  cierre?: string;
}

// El correo dice QUÉ SIGUE y no promete de más. En particular VERIFICADA no dice "pagado": el
// pedido no lo está hasta que la tienda registra el cobro en VFP.
const TEXTOS: Record<VarianteTransferencia, Textos> = {
  // Cada correo tiene UN título (el evento), UN saludo que no lo repite, y UNA indicación de qué
  // sigue. El botón ya dice la acción ("Subir mi comprobante"), así que el cierre no la vuelve a
  // pedir; y el folio no se escribe aquí: va en el resumen.
  INSTRUCCIONES: {
    titulo: 'Datos para tu transferencia',
    saludo: (_f, n) => `Hola, ${n}. Con estos datos puedes pagar tu pedido por transferencia.`,
    cta: 'Subir mi comprobante',
    cierre: 'Si prefieres pagar en tienda, pídelo en caja y te cambiamos la forma de pago.',
  },
  COMPROBANTE_RECIBIDO: {
    titulo: 'Recibimos tu comprobante',
    saludo: (_f, n) =>
      `Hola, ${n}. Estamos confirmando en el banco que tu transferencia llegó.`,
    cta: 'Ver mi pedido',
    cierre: 'Te avisaremos por correo en cuanto la confirmemos. No necesitas hacer nada más.',
  },
  VERIFICADA: {
    titulo: 'Recibimos tu transferencia',
    saludo: (_f, n) => `Hola, ${n}. Ya confirmamos tu pago en el banco.`,
    cta: 'Ver mi pedido',
    callout: { variante: 'success', etiqueta: 'Qué sigue' },
    // OJO: no dice "pagado". El pedido no lo está hasta que la tienda registra el cobro en VFP.
    cierre:
      'En cuanto la tienda registre el pago podrás recoger tu pedido. Presenta tu folio en el mostrador.',
  },
  RECHAZADA: {
    titulo: 'No pudimos validar tu comprobante',
    saludo: (_f, n) => `Hola, ${n}. Necesitamos que vuelvas a enviarlo.`,
    cta: 'Subir otro comprobante',
    callout: { variante: 'warning', etiqueta: 'Motivo' },
    cierre:
      'Si ya transferiste, no repitas la transferencia. Si prefieres pagar en tienda, pídelo en caja.',
  },
  POR_VENCER: {
    titulo: 'Tus datos de transferencia están por vencer',
    saludo: (_f, n) => `Hola, ${n}. Las instrucciones para pagar tu pedido por transferencia vencen pronto.`,
    cta: 'Ver mi pedido',
    callout: { variante: 'warning', etiqueta: 'Aviso' },
    cierre: 'Si ya transferiste, sube tu comprobante. Si no, puedes pagar en tienda.',
  },
  REEMBOLSADA: {
    titulo: 'Te devolvimos tu dinero',
    saludo: (_f, n) => `Hola, ${n}. Ya registramos la devolución del monto que transferiste.`,
    cta: 'Ver mi pedido',
    callout: { variante: 'info', etiqueta: 'Devolución' },
    cierre: 'Según tu banco, puede tardar unos minutos en reflejarse.',
  },
};

export const TransferenciaPago = ({
  variante,
  pedido,
  pedidoUrl,
  logoUrl,
  frontendUrl,
  lineas,
  notas,
  detalle,
}: TransferenciaPagoProps) => {
  const t = TEXTOS[variante];
  return (
    <PedidoEmailShell
      preview={t.titulo}
      title={t.titulo}
      greeting={t.saludo(folioVisible(pedido), pedido.clienteNombre)}
      pedido={pedido}
      pedidoUrl={pedidoUrl}
      ctaLabel={t.cta}
      ocultarProductos
      logoUrl={logoUrl}
      frontendUrl={frontendUrl}
      bodyExtras={
        <>
          {lineas && lineas.length > 0 ? (
            <Section
              style={{
                backgroundColor: colors.subtle,
                border: `1px solid ${colors.border}`,
                borderRadius: '10px',
                padding: '16px 20px',
                margin: '0 0 16px 0',
              }}
            >
              {lineas.map((l) => (
                <Text key={l.etiqueta} style={{ ...parrafo, margin: '4px 0' }}>
                  <strong>{l.etiqueta}:</strong> {l.mostrar}
                </Text>
              ))}
            </Section>
          ) : null}
          {detalle && t.callout ? (
            <Callout variant={t.callout.variante} label={t.callout.etiqueta}>
              {detalle}
            </Callout>
          ) : null}
          {notas?.map((n) => (
            <Text key={n} style={{ ...parrafo, color: colors.muted, fontSize: '13px' }}>
              • {n}
            </Text>
          ))}
          {t.cierre ? <Text style={parrafo}>{t.cierre}</Text> : null}
        </>
      }
    />
  );
};
