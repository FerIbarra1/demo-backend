import { folioVisible, type PedidoEmailData } from './mail.templates';
import { folioDe } from '../pagos/transferencia/pago-comun';

/**
 * Oct 2026 (B2): el folio que ve el cliente en el correo y en las instrucciones de pago es EL MISMO que ve el personal
 * en pantalla y que lleva el ticket: el folio del Sistema Comercial con la serie de su tienda.
 */
const correo = (extra: Partial<PedidoEmailData> = {}) =>
  ({ numeroPedido: 'PD-2026-000123', ...extra }) as PedidoEmailData;

describe('folioVisible (correos)', () => {
  it('con folio del ERP: SERIE-folio', () => {
    expect(folioVisible(correo({ folioErp: '0000152573', serieTienda: 'HMO' }))).toBe(
      'HMO-0000152573',
    );
  });

  it('sin serie todavía: el folio solo', () => {
    expect(folioVisible(correo({ folioErp: '0000152573', serieTienda: null }))).toBe('0000152573');
  });

  it('manda sobre el folio de la bandeja de envío', () => {
    expect(
      folioVisible(
        correo({ folioErp: '0000152574', serieTienda: 'MXL', externalFolio: '0000000001' }),
      ),
    ).toBe('MXL-0000152574');
  });

  it('antes del folio (el correo de "recibido"): el folio de la bandeja o, si no, el número interno', () => {
    expect(folioVisible(correo({ externalFolio: '0000000001' }))).toBe('0000000001');
    expect(folioVisible(correo())).toBe('PD-2026-000123');
  });

  it('el "PD-2026-00" que dejaba el agente anterior NO es un folio: el cliente lee el número de su pedido', () => {
    expect(folioVisible(correo({ externalFolio: 'PD-2026-00' }))).toBe('PD-2026-000123');
  });
});

describe('folioDe (instrucciones de pago)', () => {
  const base = { numeroPedido: 'PD-2026-000123', pendienteEnvio: null };

  it('el folio del ERP con la serie de la tienda', () => {
    expect(folioDe({ ...base, folioErp: '0000152573', tienda: { serie: 'HMO' } })).toBe(
      'HMO-0000152573',
    );
  });

  it('sin serie o sin tienda cargada, el folio solo', () => {
    expect(folioDe({ ...base, folioErp: '0000152573' })).toBe('0000152573');
    expect(folioDe({ ...base, folioErp: '0000152573', tienda: { serie: null } })).toBe(
      '0000152573',
    );
  });

  it('sin folio del ERP, lo de siempre', () => {
    expect(folioDe({ ...base, folioErp: null })).toBe('PD-2026-000123');
    expect(folioDe({ ...base, pendienteEnvio: { externalFolio: '0000000007' } })).toBe(
      '0000000007',
    );
  });

  it('un folio de bandeja que no es de 10 dígitos (el "PD-2026-00" del agente anterior) no se muestra', () => {
    expect(folioDe({ ...base, pendienteEnvio: { externalFolio: 'PD-2026-00' } })).toBe(
      'PD-2026-000123',
    );
  });
});
