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
import { PedidoListoEnTienda } from './templates/PedidoListoEnTienda';
import { PedidoRecibido } from './templates/PedidoRecibido';
import { PedidoRecordatorioRecoger } from './templates/PedidoRecordatorioRecoger';
import { ResetPassword } from './templates/ResetPassword';
import { RevisionPropuesta, type OrigenPropuesta } from './templates/RevisionPropuesta';
import {
  TransferenciaPago,
  type LineaCorreo,
  type VarianteTransferencia,
} from './templates/TransferenciaPago';

export type { LineaCorreo, VarianteTransferencia };

export interface ItemPedidoSnapshot {
  productoNombre: string;
  productoCodigo: string;
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
  direccionEnvio?: string | null;
  motivoCancelacion?: string | null;
  tiendaNombre?: string;
  tiendaTelefono?: string;
  /** "Calle y número, ciudad": dónde recoger. Sin ella no se pinta la tarjeta de ubicación. */
  tiendaDireccion?: string;
  /**
   * El cliente eligió pagar por transferencia. Cambia lo que dicen los correos de "recibido" y de
   * "listo para pagar": a quien transfiere no se le dice "presenta tu folio en caja".
   */
  pagoPorTransferencia?: boolean;
  /**
   * Quién recogió el pedido cuando NO fue el titular (lo captura el operador al entregar). Solo el
   * correo de "entregado" lo pinta: el titular se entera, y puede avisar si no reconoce a esa persona.
   */
  recogioNombre?: string | null;
  // Folio VFP (externalFolio). El folio visible es este; numeroPedido es interno.
  externalFolio?: string | null;
  // Data URL del QR del folio VFP (solo en el email "listo para pagar").
  qrDataUrl?: string | null;
}

/**
 * Folio visible al cliente. **Un solo número por correo.**
 *
 * El folio de VFP (`externalFolio`) es el que el cliente ve en tienda y en el
 * ERP, así que manda en cuanto existe. Antes de que el agente lo asigne (el
 * correo de "recibido" es el único caso) se usa `numeroPedido`, el folio web
 * que el cliente acaba de recibir al confirmar su compra.
 *
 * Nunca se inventa un "Pedido #id": el id interno no significa nada para el
 * cliente y mostraba un tercer número distinto a los otros dos.
 */
export function folioVisible(pedido: PedidoEmailData): string {
  return pedido.externalFolio ?? pedido.numeroPedido;
}

export interface MailContext {
  logoUrl: string;
  frontendUrl: string;
}

export const mailTemplates = {
  Bienvenida: (props: { nombre: string } & MailContext): ReactElement => Bienvenida(props),
  ResetPassword: (
    props: {
      nombre: string;
      resetUrl: string;
      expiresInMin: number;
    } & MailContext,
  ): ReactElement => ResetPassword(props),
  PedidoRecibido: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoRecibido(props),
  PedidoListoEnTienda: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoListoEnTienda(props),
  // F22: "¿aún quieres tu pedido?" — la bolsa lleva días esperando.
  PedidoRecordatorioRecoger: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoRecordatorioRecoger(props),
  RevisionPropuesta: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
      mensajeBodeguero?: string;
      // Quién escribe: bodega (faltantes), ventas (contrapropuesta) o asesor
      // (el cliente pidió uno). El texto cambia porque antes decía "bodeguero"
      // incluso cuando el mensaje venía de un asesor de ventas.
      origen?: OrigenPropuesta;
    } & MailContext,
  ): ReactElement => RevisionPropuesta(props),
  PedidoAprobado: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
      qrDataUrl?: string | null;
    } & MailContext,
  ): ReactElement => PedidoAprobado(props),
  PagoConfirmado: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PagoConfirmado(props),
  PedidoEnviado: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoEnviado(props),
  PedidoEntregado: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoEntregado(props),
  PedidoCancelado: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
    } & MailContext,
  ): ReactElement => PedidoCancelado(props),
  MensajeBodeguero: (
    props: {
      pedido: PedidoEmailData;
      pedidoUrl: string;
      mensaje: string;
      nombreBodeguero: string;
    } & MailContext,
  ): ReactElement => MensajeBodeguero(props),
  // Oct 2026: una sola plantilla para los 6 correos del pago por transferencia.
  TransferenciaPago: (
    props: {
      variante: VarianteTransferencia;
      pedido: PedidoEmailData;
      pedidoUrl: string;
      lineas?: LineaCorreo[];
      notas?: string[];
      detalle?: string;
    } & MailContext,
  ): ReactElement => TransferenciaPago(props),
};

export const mailSubjects = {
  BIENVENIDA: '¡Bienvenido a PTM! Tu cuenta está lista',
  RESET_PASSWORD: 'Recupera tu contraseña de PTM',
  PEDIDO_RECIBIDO: (n: string) => `Recibimos tu pedido ${n}`,
  // F16: el pedido está apartado en tienda esperando revisión del cliente.
  LISTO_EN_TIENDA: (n: string) => `Tu pedido ${n} ya está listo en tienda`,
  // F22: la bolsa lleva días apartada y el cliente no ha respondido.
  RECORDATORIO_RECOGER: (n: string) => `¿Aún quieres tu pedido ${n}?`,
  // F13: la propuesta puede venir de bodega (faltantes) o del asesor de ventas
  // (contrapropuesta negociada). El subject es neutro para cubrir ambos.
  REVISION_PROPUESTA: (n: string) => `Tu pedido ${n} tiene una propuesta`,
  REVISION_APROBADA: (n: string) => `Tu pedido ${n} ya está listo para pagar`,
  REVISION_RECHAZADA: (n: string) => `Tu pedido ${n} fue rechazado`,
  PAGO_CONFIRMADO: (n: string) => `Pago confirmado de tu pedido ${n}`,
  ENVIADO: (n: string) => `Tu pedido ${n} ya fue enviado`,
  ENTREGADO: (n: string) => `Tu pedido ${n} fue entregado`,
  CANCELADO: (n: string) => `Tu pedido ${n} fue cancelado`,
  MENSAJE_BODEGUERO: (n: string) =>
    `Tu asesor de ventas te ha enviado un mensaje sobre tu pedido ${n}`,
  // F13: el cliente pidió un asesor de ventas desde una propuesta.
  ASESOR_SOLICITADO: (n: string) => `Un asesor de ventas atenderá tu pedido ${n}`,
  // F13: el asesor envió una contrapropuesta.
  PROPUESTA_VENTAS: (n: string) => `Tu asesor de ventas tiene una propuesta para el pedido ${n}`,
  // Oct 2026: pago por transferencia.
  TRANSFERENCIA_INSTRUCCIONES: (n: string) => `Datos para pagar tu pedido ${n} por transferencia`,
  TRANSFERENCIA_COMPROBANTE_RECIBIDO: (n: string) => `Recibimos tu comprobante del pedido ${n}`,
  TRANSFERENCIA_VERIFICADA: (n: string) => `Recibimos tu transferencia del pedido ${n}`,
  TRANSFERENCIA_RECHAZADA: (n: string) => `No pudimos validar tu comprobante del pedido ${n}`,
  TRANSFERENCIA_POR_VENCER: (n: string) =>
    `Tus datos de transferencia del pedido ${n} están por vencer`,
  TRANSFERENCIA_REEMBOLSADA: (n: string) => `Te devolvimos tu transferencia del pedido ${n}`,
};
