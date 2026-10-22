import { BadRequestException } from '@nestjs/common';
import { RolUsuario } from '@prisma/client';
import { MessagesService } from './messages.service';

/**
 * Oct 2026: quién puede escribir en el chat del pedido.
 *
 * La regla del negocio (CLAUDE.md): desde F13 el chat es del ASESOR DE VENTAS.
 * Bodega no lee ni escribe — su trabajo es verificar existencia, no negociar.
 *
 * Lo que estos tests fijan es una INCONSISTENCIA que estaba viva: `crear`
 * prohibía a bodega escribir, pero `crearConAdjunto` lo dejaba pasar. Fue un
 * permiso que F14 abrió para que bodega mandara su propuesta desde el surtido, y
 * que F17 hizo innecesario al mover esa propuesta al servidor
 * (`core/propuesta-bodega.util.ts`). Sin un test, el próximo cambio de permisos
 * puede volver a abrir la puerta sin que nadie lo note.
 */

function crearServicio() {
  const prisma = {
    pedidoMensaje: { create: jest.fn() },
    itemPedido: { findUnique: jest.fn() },
  };

  const svc = new MessagesService(
    prisma as never,
    { cargarYValidar: jest.fn().mockResolvedValue({ id: 1, usuarioId: 7 }) } as never,
    { emitToPedido: jest.fn(), emitToUser: jest.fn() } as never, // realtime
    {} as never, // mail
    {} as never, // config
    {} as never, // propuesta
    {} as never, // configuracion
    {} as never, // state
    {} as never, // ajuste
  );

  return { svc, prisma };
}

const usuario = (rol: RolUsuario) => ({ userId: 9, rol }) as never;

describe('crear — quién puede escribir en el chat', () => {
  it.each([RolUsuario.BODEGA, RolUsuario.BODEGA_MONITOR, RolUsuario.CAJERO, RolUsuario.MOSTRADOR])(
    '%s NO puede escribir',
    async (rol) => {
      const { svc } = crearServicio();
      await expect(
        svc.crear(1, { contenido: 'hola' } as never, usuario(rol)),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

describe('crearConAdjunto — quién puede mandar una propuesta', () => {
  it.each([RolUsuario.BODEGA, RolUsuario.BODEGA_MONITOR, RolUsuario.CAJERO, RolUsuario.MOSTRADOR])(
    '%s NO puede mandar propuesta con adjunto',
    async (rol) => {
      // Este es el caso que estaba mal: BODEGA pasaba el filtro de
      // `crearConAdjunto` aunque `crear` ya lo rechazaba.
      const { svc } = crearServicio();
      await expect(
        svc.crearConAdjunto(1, { contenido: 'mira esto' } as never, usuario(rol)),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('el mensaje de error nombra a bodega como solo lectura', async () => {
    const { svc } = crearServicio();
    await expect(
      svc.crearConAdjunto(1, { contenido: 'x' } as never, usuario(RolUsuario.BODEGA)),
    ).rejects.toThrow(/Bodega/);
  });
});
