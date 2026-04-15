import { EstadoPedido, EstadoPago, TipoPago, RolUsuario, PrecioCO } from '@prisma/client';

export interface UserContext {
  userId: number;
  nombre: string;
  rol: RolUsuario;
  tiendaId?: number;
}

export interface ItemPedidoInput {
  precioCOId: number;
  cantidad: number;
}

export interface ItemPedidoData {
  productoId: number;
  precioCOId: number;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  productoNombre: string;
  productoCodigo: string;
  corridaNombre: string;
  tallaNombre: string;
  colorNombre: string;
}

export interface CrearPedidoData {
  items: ItemPedidoInput[];
  tipoPago: TipoPago;
  notas?: string;
  referenciaPago?: string;
}

export interface CambioEstadoData {
  nuevoEstado: EstadoPedido;
  observacion?: string;
}

export interface VerificacionPagoData {
  aprobado: boolean;
  observacion?: string;
}

export interface StockVerificacion {
  itemId: number;
  producto: string;
  talla: string;
  color: string;
  cantidadSolicitada: number;
  stockDisponible: number;
  suficiente: boolean;
}

export interface PrecioCOWithRelations extends PrecioCO {
  producto: {
    nombre: string;
    codigo: string;
  };
  talla: {
    nombre: string;
  };
  color: {
    nombre: string;
  };
  corrida: {
    nombre: string;
  };
  stock?: {
    cantidad: number;
    cantidadReservada: number;
  } | null;
}
