import { EstadoPedido, RolUsuario, PrecioCO } from '@prisma/client';

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
  notas?: string;
}

export interface CambioEstadoData {
  nuevoEstado: EstadoPedido;
  observacion?: string;
}

/** B2B: no hay stock en tiempo real. Tipos deprecados. */
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
}
