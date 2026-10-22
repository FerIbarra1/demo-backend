import { fraseDelHito, historialParaCliente } from './historial-cliente.util';

/**
 * El cliente ve solo los hitos de SU pedido, con frases fijas en su voz. Ver el encabezado de `historial-cliente.util.ts`.
 */
const fila = (anterior: string | null, nuevo: string, extra: Record<string, unknown> = {}) => ({
  id: 99,
  pedidoId: 17310,
  usuarioId: 4321,
  estadoAnterior: anterior,
  estadoNuevo: nuevo,
  observacion: 'Texto del personal con #45, Ana y jerga',
  usuarioNombre: 'AGENT_EXTERNAL',
  createdAt: new Date('2026-10-19T12:00:00Z'),
  ...extra,
});

describe('fraseDelHito', () => {
  it.each([
    [null, 'SOLICITADO', 'Recibimos tu pedido'],
    ['SOLICITADO', 'EN_REVISION', 'Empezamos a preparar tu pedido'],
    ['EN_REVISION', 'REVISADO', 'Tu pedido quedó listo en tienda'],
    ['REVISADO', 'EN_ATENCION', 'Te llamaron a mostrador'],
    ['EN_ATENCION', 'PENDIENTE_PAGO', 'Tu pedido pasó a pago'],
    ['PENDIENTE_PAGO', 'PAGADO', 'Recibimos tu pago'],
    ['PAGADO', 'ENVIADO', 'Tu pedido salió a envío'],
    ['PAGADO', 'ENTREGADO', 'Pedido entregado'],
    ['EN_REVISION', 'ESPERANDO_APROBACION', 'Te enviamos una propuesta para que decidas'],
    ['EN_ASESORIA', 'ESPERANDO_APROBACION', 'Tu asesor te envió una propuesta'],
    ['REVISADO', 'EN_REVISION', 'Tu pedido volvió a preparación para aplicar los cambios'],
    ['ESPERANDO_APROBACION', 'REVISADO', 'Se confirmaron los cambios de tu pedido'],
    ['ESPERANDO_APROBACION', 'PENDIENTE_PAGO', 'Se confirmaron los cambios de tu pedido'],
    ['ESPERANDO_APROBACION', 'CANCELADO', 'Pedido cancelado'],
    ['EN_REVISION', 'EN_DTF', 'Empezamos la impresión de tu DTF'],
  ])('%s → %s: «%s»', (a, n, esperada) => {
    expect(fraseDelHito(a, n)).toBe(esperada);
  });

  it('los vaivenes internos no son un hito', () => {
    expect(fraseDelHito('EN_ATENCION', 'REVISADO')).toBeNull(); // deshacer la llamada
    expect(fraseDelHito('EN_REVISION', 'SOLICITADO')).toBeNull(); // devuelto a la cola de preparación
  });

  it('ninguna frase lleva jerga, números internos ni nombres de piso', () => {
    const estados = [
      'SOLICITADO', 'EN_REVISION', 'ESPERANDO_APROBACION', 'EN_ASESORIA', 'EN_DTF', 'REVISADO',
      'EN_ATENCION', 'PENDIENTE_PAGO', 'PAGADO', 'ENVIADO', 'ENTREGADO', 'CANCELADO',
    ];
    for (const a of [null, ...estados]) {
      for (const n of estados) {
        const f = fraseDelHito(a, n);
        if (f) expect(f).not.toMatch(/#\d|bodega|plancha|ventanilla|sistema comercial|firebird|vfp|erp|[A-Z]{3,}_[A-Z]+/i);
      }
    }
  });
});

describe('historialParaCliente', () => {
  it('entrega SOLO lo que la pantalla pinta, con la frase del hito y sin quién lo hizo', () => {
    const [h] = historialParaCliente([fila('PENDIENTE_PAGO', 'PAGADO')]);
    expect(Object.keys(h).sort()).toEqual(
      ['createdAt', 'estadoAnterior', 'estadoNuevo', 'observacion', 'usuarioNombre'].sort(),
    );
    expect(h).toEqual({
      estadoAnterior: 'PENDIENTE_PAGO',
      estadoNuevo: 'PAGADO',
      observacion: 'Recibimos tu pago',
      usuarioNombre: '',
      createdAt: new Date('2026-10-19T12:00:00Z'),
    });
  });

  it('el texto libre del personal (ids, nombres, jerga) NUNCA llega al cliente', () => {
    const r = historialParaCliente([
      fila(null, 'SOLICITADO'),
      fila('SOLICITADO', 'EN_REVISION'),
      fila('EN_REVISION', 'REVISADO'),
    ]);
    const todo = JSON.stringify(r);
    expect(todo).not.toMatch(/#45|Ana|AGENT_EXTERNAL|jerga|4321|17310/);
  });

  it('los movimientos del mismo estado (llamadas, descartes, avisos, tomar y liberar) no se muestran', () => {
    const r = historialParaCliente([
      fila('REVISADO', 'REVISADO'),
      fila('EN_REVISION', 'EN_REVISION'),
      fila('REVISADO', 'EN_ATENCION'),
    ]);
    expect(r.map((x) => x.observacion)).toEqual(['Te llamaron a mostrador']);
  });

  it('deshacer una llamada y volver a llamar se cuenta UNA vez', () => {
    const r = historialParaCliente([
      fila('REVISADO', 'EN_ATENCION'),
      fila('EN_ATENCION', 'REVISADO'),
      fila('REVISADO', 'EN_ATENCION'),
    ]);
    expect(r.map((x) => x.observacion)).toEqual(['Te llamaron a mostrador']);
  });

  it('conserva el orden y el primer movimiento (sin estado anterior)', () => {
    const r = historialParaCliente([fila(null, 'SOLICITADO'), fila('SOLICITADO', 'EN_REVISION')]);
    expect(r.map((x) => x.estadoNuevo)).toEqual(['SOLICITADO', 'EN_REVISION']);
    expect(r[0].estadoAnterior).toBeNull();
  });
});
