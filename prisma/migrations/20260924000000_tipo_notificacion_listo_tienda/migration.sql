-- F16 (sep 2026): nuevo tipo de notificación para el estado EN_MOSTRADOR.
-- El pedido queda apartado en tienda esperando que el cliente lo revise antes
-- de pagar; antes no se le avisaba por correo.
ALTER TYPE "TipoNotificacion" ADD VALUE IF NOT EXISTS 'LISTO_EN_TIENDA';
