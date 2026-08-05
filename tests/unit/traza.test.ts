/**
 * La traza es un instrumento de diagnostico, y un instrumento que miente es
 * peor que no tenerlo: manda a buscar el fallo donde no esta.
 *
 * Estas pruebas cubren las tres formas en que podria mentir:
 *   1. Contando mal el reparto del tiempo o las llamadas al modelo.
 *   2. Perdiendo el salto en el que el turno murio.
 *   3. Sacando por HTTP un telefono o un DNI sin enmascarar (control C6).
 */
import { describe, expect, it } from 'vitest';

import {
  TRAZA_NULA,
  TurnoEnTrazaImpl,
  type TrazaDeTurno,
} from '../../src/core/observabilidad/traza.js';
import { RecolectorDeTrazaEnMemoria } from '../../src/infra/traza.memoria.js';

/** Reloj falso: la traza mide tiempo y el tiempo real no es reproducible. */
function relojFalso(): { ahora: () => number; avanzar: (ms: number) => void } {
  let t = 1_000_000;
  return {
    ahora: () => t,
    avanzar: (ms: number) => {
      t += ms;
    },
  };
}

function turno(reloj: ReturnType<typeof relojFalso>): {
  turno: TurnoEnTrazaImpl;
  recogida: () => TrazaDeTurno;
} {
  let capturada: TrazaDeTurno | undefined;
  const impl = new TurnoEnTrazaImpl(
    { canal: 'whatsapp', entrada: 'hola', conversationId: 'c1', clinicId: 'k1' },
    (t) => {
      capturada = t;
    },
    reloj.ahora,
  );
  return {
    turno: impl,
    recogida: () => {
      if (!capturada) throw new Error('el turno no se entrego');
      return capturada;
    },
  };
}

describe('TurnoEnTraza — el resumen se deriva de los saltos', () => {
  it('reparte el tiempo entre modelo, herramientas y RAG', () => {
    const reloj = relojFalso();
    const { turno: t, recogida } = turno(reloj);

    const rag = t.iniciar('rag', 'recuperar');
    reloj.avanzar(200);
    rag.fin();

    const m1 = t.iniciar('modelo', 'llamada 1');
    reloj.avanzar(3000);
    m1.fin();

    const tool = t.iniciar('herramienta', 'consultar_agenda');
    reloj.avanzar(700);
    tool.fin();

    const m2 = t.iniciar('modelo', 'llamada 2');
    reloj.avanzar(2500);
    m2.fin();

    reloj.avanzar(100); // tiempo que no cae en ningun tramo medido
    t.cerrar('listo');

    const r = recogida().resumen;
    expect(r.llamadasAlModelo).toBe(2);
    expect(r.msModelo).toBe(5500);
    expect(r.msHerramientas).toBe(700);
    expect(r.msRag).toBe(200);
    expect(r.msOtros).toBe(100);
    expect(recogida().duracionMs).toBe(6500);
  });

  it('cuenta cuantas veces se llamo a CADA herramienta', () => {
    // Es la causa principal de latencia: cada llamada de mas obliga a una ida
    // y vuelta mas al modelo. Un total no lo dice; el desglose si.
    const reloj = relojFalso();
    const { turno: t, recogida } = turno(reloj);

    for (const nombre of ['consultar_agenda', 'consultar_rag', 'consultar_agenda']) {
      const m = t.iniciar('herramienta', nombre);
      reloj.avanzar(100);
      m.fin();
    }
    t.cerrar('listo');

    expect(recogida().resumen.herramientas).toEqual({ consultar_agenda: 2, consultar_rag: 1 });
  });

  it('un salto sin cerrar sigue apareciendo: es donde murio el turno', () => {
    const reloj = relojFalso();
    const { turno: t, recogida } = turno(reloj);

    t.iniciar('modelo', 'llamada 1'); // nunca se cierra: el turno revento aqui
    reloj.avanzar(500);
    t.cerrar('');

    const saltos = recogida().saltos;
    expect(saltos).toHaveLength(1);
    expect(saltos[0]?.nombre).toBe('llamada 1');
    expect(saltos[0]?.duracionMs).toBe(0);
  });

  it('cerrar dos veces entrega una sola traza', () => {
    const reloj = relojFalso();
    let veces = 0;
    const t = new TurnoEnTrazaImpl(
      { canal: 'voice', entrada: 'x' },
      () => {
        veces += 1;
      },
      reloj.ahora,
    );
    t.cerrar('a');
    t.cerrar('b');
    expect(veces).toBe(1);
  });

  it('un turno que muere antes del enrutado se entrega igual', () => {
    // Sin conversacion no hay identificador, y aun asi tiene que verse: es
    // justo el caso que una traza que empezara mas tarde no capturaria.
    const reloj = relojFalso();
    let capturada: TrazaDeTurno | undefined;
    const t = new TurnoEnTrazaImpl(
      { canal: 'whatsapp', entrada: 'hola' },
      (x) => {
        capturada = x;
      },
      reloj.ahora,
    );
    t.marcar('enrutado', 'fallo', 'error');
    t.cerrar('');

    expect(capturada?.conversationId).toBe('sin-conversacion');
    expect(capturada?.saltos[0]?.estado).toBe('error');
  });
});

describe('TRAZA_NULA — sin recolector, nada cambia', () => {
  it('acepta todas las llamadas y no lanza', () => {
    const t = TRAZA_NULA.abrir({ canal: 'whatsapp', entrada: 'hola' });
    expect(() => {
      t.identificar({ conversationId: 'c1' });
      t.iniciar('modelo', 'x').fin({ estado: 'error' });
      t.marcar('capa2', 'y');
      t.anotar({ tokensIn: 10 });
      t.cerrar('z');
    }).not.toThrow();
  });
});

describe('RecolectorDeTrazaEnMemoria', () => {
  it('enmascara PII antes de guardar (control C6)', () => {
    // La traza se sirve por HTTP y lleva lo que dijo el paciente y con que
    // argumentos se llamo a las herramientas. Es exactamente el material que
    // el control C6 existe para que no se escape.
    const recolector = new RecolectorDeTrazaEnMemoria();
    const t = recolector.abrir({
      canal: 'whatsapp',
      entrada: 'soy Rosa, mi telefono es +51987654321 y mi DNI 45678912',
      conversationId: 'c1',
      clinicId: 'k1',
    });
    t.marcar('herramienta', 'guardar_lead', 'ok', { telefono: '+51987654321' });
    t.cerrar('le escribimos al +51987654321');

    const guardada = recolector.listar()[0];
    expect(guardada).toBeDefined();
    expect(guardada?.entrada).not.toContain('987654321');
    expect(guardada?.entrada).not.toContain('45678912');
    expect(guardada?.salida).not.toContain('987654321');
    expect(JSON.stringify(guardada?.saltos)).not.toContain('987654321');
    // Enmascarar no es borrar: el turno sigue siendo legible.
    expect(guardada?.entrada).toContain('Rosa');
  });

  it('devuelve la ultima traza DE ESA conversacion, no la mas reciente', () => {
    // Con dos pestanas abiertas son dos pacientes: coger la mas reciente
    // mostraria el turno del otro.
    const recolector = new RecolectorDeTrazaEnMemoria();
    for (const [conv, texto] of [
      ['c1', 'pregunta de Ana'],
      ['c2', 'pregunta de Beto'],
    ] as const) {
      const t = recolector.abrir({ canal: 'whatsapp', entrada: texto, conversationId: conv, clinicId: 'k' });
      t.cerrar('ok');
    }

    expect(recolector.ultimaDe('c1')?.entrada).toBe('pregunta de Ana');
    expect(recolector.ultimaDe('c2')?.entrada).toBe('pregunta de Beto');
    expect(recolector.ultimaDe('c9')).toBeUndefined();
  });

  it('respeta el tope y tira las mas antiguas', () => {
    const recolector = new RecolectorDeTrazaEnMemoria({ maxTrazas: 2 });
    for (const n of ['a', 'b', 'c']) {
      recolector.abrir({ canal: 'voice', entrada: n, conversationId: n, clinicId: 'k' }).cerrar('ok');
    }
    expect(recolector.total).toBe(2);
    expect(recolector.listar().map((t) => t.entrada)).toEqual(['c', 'b']);
  });

  it('conserva las fechas: son el dato que mas se diagnostica', () => {
    /**
     * Un `Date` no tiene propiedades enumerables, asi que el recorte generico
     * por `Object.entries` lo dejaba en `{}`. Los huecos de agenda llegaban al
     * panel como `{"start":{},"end":{}}` y era imposible saber que horarios
     * habia devuelto la herramienta, que es justo lo que hacia falta para
     * diagnosticar por que el agente ofrecia horas raras.
     */
    const recolector = new RecolectorDeTrazaEnMemoria();
    const t = recolector.abrir({ canal: 'whatsapp', entrada: 'x', conversationId: 'c', clinicId: 'k' });
    t.marcar('herramienta', 'consultar_agenda', 'ok', {
      slots: [{ start: new Date('2026-08-07T14:00:00Z'), end: new Date('2026-08-07T14:40:00Z') }],
    });
    t.cerrar('ok');

    const slots = recolector.listar()[0]?.saltos[0]?.detalle['slots'] as Array<Record<string, unknown>>;
    expect(slots[0]?.['start']).toBe('2026-08-07T14:00:00.000Z');
    expect(slots[0]?.['end']).toBe('2026-08-07T14:40:00.000Z');
  });

  it('recorta los campos largos en vez de guardar el prompt entero', () => {
    const recolector = new RecolectorDeTrazaEnMemoria({ maxCaracteresPorCampo: 20 });
    const t = recolector.abrir({ canal: 'whatsapp', entrada: 'x', conversationId: 'c', clinicId: 'k' });
    t.marcar('prompt', 'ensamblar', 'ok', { system: 'y'.repeat(500) });
    t.cerrar('ok');

    const detalle = recolector.listar()[0]?.saltos[0]?.detalle['system'];
    expect(String(detalle)).toContain('[+480 caracteres]');
    expect(String(detalle).length).toBeLessThan(60);
  });
});
