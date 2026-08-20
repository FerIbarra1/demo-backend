/**
 * Re-exports tipados de las plantillas React Email. Centraliza el contrato
 * que el resto del código usa para mandar emails: importar de aquí
 * garantiza que la prop-shape de cada plantilla esté sincronizada con el
 * componente .tsx.
 */
import { ReactElement } from 'react';
import type { Decimal } from '@prisma/client/runtime/library';

import { Bienvenida } from './templates/Bienvenida';
import { MensajeBodeguero } from './templates/MensajeBodeguero';
import { PagoConfirmado } from './templates/PagoConfirmado';
import { PedidoAprobado } from './templates/PedidoAprobado';
import { PedidoCancelado } from './templates/PedidoCancelado';
import { PedidoEntregado } from './templates/PedidoEntregado';
import { PedidoEnviado } from './templates/PedidoEnviado';
import { PedidoRecibido } from './templates/PedidoRecibido';
import { ResetPassword } from './templates/ResetPassword';
import { RevisionPropuesta } from './templates/RevisionPropuesta';

export interface ItemPedidoSnapshot {
  productoNombre: string;
  tallaNombre: string;
  colorNombre: string;
  cantidad: number;
  precioUnitario: number | string | Decimal;
  subtotal: number | string | Decimal;
  imagenUrl?: string | null;
}

export interface PedidoEmailData {
  pedidoId: number;
  numeroPedido: string;
  clienteNombre: string;
  estado: string;
  total: number | string | Decimal;
  fechaPedido: Date | string;
  items?: ItemPedidoSnapshot[];
  paqueteria?: string | null;
  numeroGuia?: string | null;
  direccionEnvio?: string | null;
  motivoCancelacion?: string | null;
  tiendaNombre?: string;
  tiendaTelefono?: string;
}

export interface MailContext {
  logoUrl: string;
  frontendUrl: string;
}

export const mailTemplates = {
  Bienvenida: (props: { nombre: string } & MailContext): ReactElement =>
    Bienvenida(props),
  ResetPassword: (props: {
    nombre: string;
    resetUrl: string;
    expiresInMin: number;
  } & MailContext): ReactElement => ResetPassword(props),
  PedidoRecibido: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PedidoRecibido(props),
  RevisionPropuesta: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
    mensajeBodeguero?: string;
  } & MailContext): ReactElement => RevisionPropuesta(props),
  PedidoAprobado: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PedidoAprobado(props),
  PagoConfirmado: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PagoConfirmado(props),
  PedidoEnviado: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PedidoEnviado(props),
  PedidoEntregado: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PedidoEntregado(props),
  PedidoCancelado: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
  } & MailContext): ReactElement => PedidoCancelado(props),
  MensajeBodeguero: (props: {
    pedido: PedidoEmailData;
    pedidoUrl: string;
    mensaje: string;
    nombreBodeguero: string;
  } & MailContext): ReactElement => MensajeBodeguero(props),
};

export const mailSubjects = {
  BIENVENIDA: '¡Bienvenido a PTM! Tu cuenta está lista',
  RESET_PASSWORD: 'Recupera tu contraseña de PTM',
  PEDIDO_RECIBIDO: (n: string) => `Recibimos tu pedido ${n}`,
  REVISION_PROPUESTA: (n: string) =>
    `Tu pedido ${n} tiene una propuesta del bodeguero`,
  REVISION_APROBADA: (n: string) => `Tu pedido ${n} fue aprobado`,
  REVISION_RECHAZADA: (n: string) => `Tu pedido ${n} fue rechazado`,
  PAGO_CONFIRMADO: (n: string) => `Pago confirmado de tu pedido ${n}`,
  ENVIADO: (n: string) => `Tu pedido ${n} ya fue enviado`,
  ENTREGADO: (n: string) => `Tu pedido ${n} fue entregado`,
  CANCELADO: (n: string) => `Tu pedido ${n} fue cancelado`,
  MENSAJE_BODEGUERO: (n: string) =>
    `El bodeguero te ha enviado un mensaje sobre tu pedido ${n}`,
};
