-- Oct 2026: destrabar pedidos, etapa 2. Aditiva: solo agrega un valor al enum de tareas del Sistema Comercial.
--
-- `ANULAR_VENTA_EN_ERP`: el ADMIN canceló un pedido que ya estaba cobrado. A diferencia de `CANCELAR_EN_ERP` (pedido sin
-- cobro, que en el ERP solo se marca cancelado), aquí el cobro existe allá y hay que anular la venta y devolver el dinero.
-- Ningún dato existente cambia ni se usa el valor nuevo dentro de esta misma migración.

-- AlterEnum
ALTER TYPE "TipoTareaErp" ADD VALUE 'ANULAR_VENTA_EN_ERP';
