import { BadRequestException } from '@nestjs/common';
import { SyncAgentController } from './sync-agent.controller';

const upload = {
  tiendaId: 5,
  hastaBANDEJAId: 12,
  eventos: [{
    eventId: 'BANDEJA:12:PRODUCTOS:1:GLOBAL',
    bandejaId: 12,
    tipo: 'CATALOGO' as const,
    operacion: 'U' as const,
    entidad: 'PRODUCTOS',
    localId: 1,
    datos: { CODIGO: 'CAM-001' },
  }],
};

const ack = {
  tiendaId: 5,
  acks: [{
    pedidoId: 101,
    agentId: 'agent-test',
    leaseToken: 'lease-101',
    externalIdPEDIDOS: 501,
    externalFolio: 'F-501',
    exito: true,
  }],
};

describe('SyncAgentController contract', () => {
  it('accepts upload only when body and header identify the same store', async () => {
    const service = { procesarUpload: jest.fn().mockResolvedValue({
      procesados: 1,
      errores: 0,
      checkpointAvanzado: true,
    }) };
    const controller = new SyncAgentController(service as any);

    await expect(controller.upload(upload as any, '5')).resolves.toEqual({
      procesados: 1,
      errores: 0,
      checkpointAvanzado: true,
    });
    expect(service.procesarUpload).toHaveBeenCalledWith(upload);
  });

  it('rejects upload when body and header stores differ', async () => {
    const service = { procesarUpload: jest.fn() };
    const controller = new SyncAgentController(service as any);

    await expect(controller.upload(upload as any, '6')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.procesarUpload).not.toHaveBeenCalled();
  });

  it('requires agent identity for polling', async () => {
    const service = { pollPedidos: jest.fn() };
    const controller = new SyncAgentController(service as any);

    await expect(controller.pollPedidos('5', '', '20')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.pollPedidos).not.toHaveBeenCalled();
  });

  it('passes lease-bearing ACKs only after matching the store header', async () => {
    const service = { procesarPedidosAck: jest.fn().mockResolvedValue({ actualizados: 1, errores: 0 }) };
    const controller = new SyncAgentController(service as any);

    await expect(controller.pedidosAck(ack as any, '5')).resolves.toEqual({
      actualizados: 1,
      errores: 0,
    });
    expect(service.procesarPedidosAck).toHaveBeenCalledWith(ack);
  });
});
