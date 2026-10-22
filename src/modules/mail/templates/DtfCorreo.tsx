import * as React from 'react';
import { Text } from '@react-email/components';
import { EmailLayout } from './Layout';
import { Button } from './Button';
import { Callout } from './Callout';

export interface DtfCorreoProps {
  preview: string;
  titulo: string;
  saludo: string;
  /** Líneas de texto del cuerpo. */
  parrafos: string[];
  /** Aviso destacado (motivos de corrección, motivo del rechazo…). */
  aviso?: { variante: 'info' | 'warning' | 'danger'; etiqueta: string; lineas: string[] };
  boton: { texto: string; url: string };
  logoUrl: string;
  frontendUrl: string;
}

/** Correo de una sola plantilla para los 3 avisos de DTF (aprobado, necesita corrección, rechazado). */
export const DtfCorreo = (p: DtfCorreoProps) => (
  <EmailLayout preview={p.preview} logoUrl={p.logoUrl} frontendUrl={p.frontendUrl}>
    <Text style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 8px 0', color: '#1c1917' }}>
      {p.titulo}
    </Text>
    <Text style={{ fontSize: '15px', margin: '0 0 16px 0', color: '#44403c', lineHeight: '1.6' }}>
      {p.saludo}
    </Text>
    {p.parrafos.map((t, i) => (
      <Text
        key={i}
        style={{ fontSize: '14px', margin: '0 0 12px 0', color: '#1c1917', lineHeight: '1.6' }}
      >
        {t}
      </Text>
    ))}
    {p.aviso ? (
      <Callout variant={p.aviso.variante} label={p.aviso.etiqueta}>
        {p.aviso.lineas.join(' · ')}
      </Callout>
    ) : null}
    <Button href={p.boton.url}>{p.boton.texto}</Button>
  </EmailLayout>
);
