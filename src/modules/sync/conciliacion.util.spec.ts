import { EstadoPedido as E, TipoTareaErp as T } from '@prisma/client';
import { conciliar, EstadoErp, EstadoNube, textoDeHallazgo } from './conciliacion.util';

const erp = (o: Partial<EstadoErp> = {}): EstadoErp => ({
  existe: true,
  swcancel: false,
  finalizada: false,
  total: 100,
  ...o,
});
const nube = (estado: E, o: Partial<EstadoNube> = {}): EstadoNube => ({
  estado,
  total: 100,
  tareasAbiertas: [],
  ...o,
});
const tipos = (e: EstadoErp, n: EstadoNube) => conciliar(e, n).hallazgos.map((h) => h.tipo);

describe('conciliar — lo que dice el Sistema Comercial contra lo que dice la nube', () => {
  it('todo cuadra: sin hallazgos, sin nada que aplicar', () => {
    for (const estado of [E.PENDIENTE_PAGO, E.PAGADO, E.ENVIADO]) {
      const v = conciliar(erp({ finalizada: estado !== E.PENDIENTE_PAGO }), nube(estado));
      expect(v).toEqual({ hallazgos: [], aplicar: null, cerrarTareas: [] });
    }
  });

  describe('el ERP cobró', () => {
    it('la nube lo tenía por pagar → COBRO_PERDIDO y se aplica el cobro (lo corrige sola)', () => {
      const v = conciliar(erp({ finalizada: true }), nube(E.PENDIENTE_PAGO));
      expect(v.aplicar).toBe('COBRO');
      expect(v.hallazgos.map((h) => h.tipo)).toEqual(['COBRO_PERDIDO']);
    });

    it('la nube ya lo tenía cobrado: nada, y si había una tarea de "registrar el cobro", queda cumplida', () => {
      for (const estado of [E.PAGADO, E.ENVIADO, E.ENTREGADO]) {
        const v = conciliar(
          erp({ finalizada: true }),
          nube(estado, { tareasAbiertas: [T.REGISTRAR_COBRO_EN_ERP] }),
        );
        expect(v).toEqual({
          hallazgos: [],
          aplicar: null,
          cerrarTareas: [T.REGISTRAR_COBRO_EN_ERP],
        });
      }
    });

    it('la nube lo canceló → COBRADO_Y_CANCELADO: hay dinero, NO se toca solo', () => {
      const v = conciliar(erp({ finalizada: true }), nube(E.CANCELADO));
      expect(v.aplicar).toBeNull();
      expect(v.hallazgos.map((h) => h.tipo)).toEqual(['COBRADO_Y_CANCELADO']);
    });

    it('la nube ni siquiera lo mandaba a pagar → ESTADO_DISTINTO (no se aplica un cobro a ciegas)', () => {
      expect(tipos(erp({ finalizada: true }), nube(E.EN_ATENCION))).toEqual(['ESTADO_DISTINTO']);
      expect(conciliar(erp({ finalizada: true }), nube(E.REVISADO)).aplicar).toBeNull();
    });
  });

  describe('el ERP canceló', () => {
    it('la nube lo tenía vivo → CANCELACION_PERDIDA y se aplica la cancelación', () => {
      for (const estado of [E.PENDIENTE_PAGO, E.PAGADO, E.ENVIADO]) {
        const v = conciliar(erp({ swcancel: true, total: 0 }), nube(estado));
        expect(v.aplicar).toBe('CANCELACION');
        expect(v.hallazgos.map((h) => h.tipo)).toEqual(['CANCELACION_PERDIDA']);
      }
    });

    it('la nube ya lo había cancelado: nada, y la tarea de "cancelar allá" queda cumplida', () => {
      const v = conciliar(
        erp({ swcancel: true, total: 0 }),
        nube(E.CANCELADO, { tareasAbiertas: [T.CANCELAR_EN_ERP] }),
      );
      expect(v).toEqual({ hallazgos: [], aplicar: null, cerrarTareas: [T.CANCELAR_EN_ERP] });
    });

    it('ANULAR_VENTA no se cierra sola: devolver el dinero no se deduce de SWCANCEL', () => {
      const v = conciliar(
        erp({ swcancel: true, total: 0 }),
        nube(E.CANCELADO, { tareasAbiertas: [T.ANULAR_VENTA_EN_ERP] }),
      );
      expect(v.cerrarTareas).toEqual([]);
    });

    it('un pedido ya entregado y cancelado en el ERP → ESTADO_DISTINTO, sin aplicar nada', () => {
      const v = conciliar(erp({ swcancel: true, total: 0 }), nube(E.ENTREGADO));
      expect(v.aplicar).toBeNull();
      expect(v.hallazgos.map((h) => h.tipo)).toEqual(['ESTADO_DISTINTO']);
    });

    it('cancelado en el ERP cobra prioridad sobre FINALIZADA: no se "cobra" un pedido cancelado', () => {
      const v = conciliar(
        erp({ swcancel: true, finalizada: true, total: 0 }),
        nube(E.PENDIENTE_PAGO),
      );
      expect(v.aplicar).toBe('CANCELACION');
    });

    it('el total en 0 de un pedido cancelado no es una diferencia', () => {
      expect(conciliar(erp({ swcancel: true, total: 0 }), nube(E.CANCELADO)).hallazgos).toEqual([]);
    });
  });

  describe('el ERP no cobró ni canceló', () => {
    it('la nube lo tiene pagado y NADA lo explica → REVERSA_DE_COBRO', () => {
      expect(tipos(erp(), nube(E.PAGADO))).toEqual(['REVERSA_DE_COBRO']);
    });

    it('la nube lo tiene pagado A MANO y caja aún no lo registra allá: es lo esperado, sin hallazgo', () => {
      const v = conciliar(erp(), nube(E.PAGADO, { tareasAbiertas: [T.REGISTRAR_COBRO_EN_ERP] }));
      expect(v.hallazgos).toEqual([]);
      expect(v.cerrarTareas).toEqual([]);
    });

    it('cancelado en la nube y vivo allá SIN tarea → CANCELADO_VIVO_EN_ERP; con la tarea abierta, es lo esperado', () => {
      expect(tipos(erp(), nube(E.CANCELADO))).toEqual(['CANCELADO_VIVO_EN_ERP']);
      expect(tipos(erp(), nube(E.CANCELADO, { tareasAbiertas: [T.CANCELAR_EN_ERP] }))).toEqual([]);
      expect(tipos(erp(), nube(E.CANCELADO, { tareasAbiertas: [T.ANULAR_VENTA_EN_ERP] }))).toEqual(
        [],
      );
    });
  });

  describe('el total', () => {
    it('distinto → TOTAL_DISTINTO con los dos montos; un centavo de redondeo no cuenta', () => {
      const v = conciliar(erp({ total: 250 }), nube(E.PENDIENTE_PAGO, { total: 100 }));
      expect(v.hallazgos).toHaveLength(1);
      expect(v.hallazgos[0]).toMatchObject({
        tipo: 'TOTAL_DISTINTO',
        detalle: { totalNube: 100, totalErp: 250 },
      });
      expect(tipos(erp({ total: 100.005 }), nube(E.PENDIENTE_PAGO))).toEqual([]);
    });

    it('sin total en el ERP (null) no se compara', () => {
      expect(tipos(erp({ total: null }), nube(E.PENDIENTE_PAGO, { total: 999 }))).toEqual([]);
    });

    it('se suma a un cobro perdido: ambos hallazgos, y el cobro se aplica igual', () => {
      const v = conciliar(
        erp({ finalizada: true, total: 80 }),
        nube(E.PENDIENTE_PAGO, { total: 100 }),
      );
      expect(v.hallazgos.map((h) => h.tipo)).toEqual(['COBRO_PERDIDO', 'TOTAL_DISTINTO']);
      expect(v.aplicar).toBe('COBRO');
    });
  });

  describe('el pedido ya no existe en el ERP', () => {
    it('vivo en la nube → NO_EXISTE_EN_ERP; ya cerrado (cancelado o entregado) no importa', () => {
      const ausente = erp({ existe: false, total: null });
      expect(tipos(ausente, nube(E.PENDIENTE_PAGO))).toEqual(['NO_EXISTE_EN_ERP']);
      expect(tipos(ausente, nube(E.PAGADO))).toEqual(['NO_EXISTE_EN_ERP']);
      expect(tipos(ausente, nube(E.CANCELADO))).toEqual([]);
      expect(tipos(ausente, nube(E.ENTREGADO))).toEqual([]);
    });
  });

  it('cada tipo tiene su texto, y uno desconocido no revienta', () => {
    for (const t of [
      'NO_EXISTE_EN_ERP',
      'COBRO_PERDIDO',
      'CANCELACION_PERDIDA',
      'COBRADO_Y_CANCELADO',
      'REVERSA_DE_COBRO',
      'CANCELADO_VIVO_EN_ERP',
      'TOTAL_DISTINTO',
      'ESTADO_DISTINTO',
      'LO_QUE_SEA',
    ]) {
      const x = textoDeHallazgo(t);
      expect(x.titulo.length).toBeGreaterThan(3);
      expect(x.que.length).toBeGreaterThan(10);
    }
  });
});
