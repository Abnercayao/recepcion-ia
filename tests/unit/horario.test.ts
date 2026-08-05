/**
 * Cuando atiende la clinica.
 *
 * Estas pruebas existen porque el codigo anterior leia una clave de
 * configuracion que la semilla no tiene (`horario` en vez de `horarios`) y, en
 * vez de avisar, aplicaba un defecto inventado de 08:00-20:00 de lunes a
 * sabado. El resultado: el agente agendaba antes de abrir, en la pausa de
 * mediodia, despues de cerrar, el sabado por la tarde y en feriado, siempre con
 * total aplomo.
 *
 * El caso `2026-08-06` no es un ejemplo cualquiera: es el dia que el usuario
 * reporto. Batalla de Junin, ninguna sede atiende.
 */
import { describe, expect, it } from 'vitest';

import {
  cierresProximos,
  describirInstante,
  esSoloFecha,
  fechaLocal,
  generarCandidatos,
  instanteLocal,
  interpretarInstante,
  isoLocal,
  resolverAgenda,
  verificarApertura,
} from '../../src/core/agenda/horario.js';
import type { Clinic } from '../../src/core/types/index.js';

const LIMA = 'America/Lima';

function clinica(config: Record<string, unknown>): Clinic {
  return {
    id: 'c1',
    nombre: 'Clinica Aurora',
    timezone: LIMA,
    config,
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: [],
  };
}

/** La forma REAL de la semilla, la que el codigo no leia. */
const CONFIG_REAL = {
  horarios: {
    lunes_viernes: [
      ['09:00', '13:00'],
      ['14:00', '19:00'],
    ],
    sabado: [['09:00', '13:00']],
    domingo: [],
  },
  feriados: [
    { fecha: '2026-08-06', motivo: 'Batalla de Junin' },
    { fecha: '2026-07-28', motivo: 'Fiestas Patrias' },
  ],
  duracion_cita_min: 40,
};

const agendaReal = resolverAgenda(clinica(CONFIG_REAL));

/** Instante a partir de una hora local de Lima, sin depender del reloj del servidor. */
const enLima = (iso: string): Date => new Date(`${iso}-05:00`);

describe('resolverAgenda — lee la configuracion que existe de verdad', () => {
  it('entiende `horarios` en plural, con tramos y pausa de mediodia', () => {
    expect(agendaReal.configurado).toBe(true);
    expect(agendaReal.porDia.get(1)).toEqual([
      { desde: 9 * 60, hasta: 13 * 60 },
      { desde: 14 * 60, hasta: 19 * 60 },
    ]);
    expect(agendaReal.porDia.get(6)).toEqual([{ desde: 9 * 60, hasta: 13 * 60 }]);
    expect(agendaReal.porDia.get(0)).toEqual([]);
    expect(agendaReal.duracionCitaMin).toBe(40);
  });

  it('sigue entendiendo la forma antigua en singular', () => {
    const a = resolverAgenda(
      clinica({ horario: { horaApertura: '08:00', horaCierre: '20:00', diasLaborables: [1, 2, 3] } }),
    );
    expect(a.configurado).toBe(true);
    expect(a.porDia.get(1)).toEqual([{ desde: 8 * 60, hasta: 20 * 60 }]);
    expect(a.porDia.get(4)).toEqual([]);
  });

  it('sin horario declarado avisa y cierra de mas, en vez de abrir de mas', () => {
    // El defecto anterior abria lunes a sabado de 08:00 a 20:00 EN SILENCIO, y
    // por eso se colaban las citas fuera de hora. Ante la duda, cerrar: una
    // cita perdida se recupera, un paciente ante una puerta cerrada no.
    const a = resolverAgenda(clinica({}));
    expect(a.configurado).toBe(false);
    expect(a.porDia.get(6)).toEqual([]);
    expect(a.porDia.get(0)).toEqual([]);
  });
});

describe('horario POR SEDE', () => {
  /**
   * Los datos reales de la clinica desmienten el supuesto del proyecto: el
   * horario NO es uniforme. Cajamarca abre a las 08:30, Chiclayo cierra a las
   * 20:00 y Primavera abre tambien el sabado por la tarde. Con un horario
   * unico, `verificarApertura` rechazaria citas legitimas en esas sedes y le
   * diria al paciente que no se atiende cuando si se atiende.
   */
  const clinicaMultisede = clinica({
    horarios: {
      lunes_viernes: [
        ['09:00', '13:00'],
        ['14:00', '19:00'],
      ],
      sabado: [['09:00', '13:00']],
      domingo: [],
    },
    horarios_por_sede: {
      chiclayo: {
        lunes_viernes: [
          ['09:00', '13:00'],
          ['15:00', '20:00'],
        ],
        sabado: [['09:00', '13:00']],
        domingo: [],
      },
      primavera: {
        lunes_viernes: [
          ['09:00', '13:00'],
          ['14:00', '19:00'],
        ],
        sabado: [
          ['09:00', '13:00'],
          ['14:00', '19:00'],
        ],
        domingo: [],
      },
    },
  });

  const cabeEn = (sede: string | undefined, inicio: string, minutos = 40): boolean => {
    const a = resolverAgenda(clinicaMultisede, undefined, sede);
    const d = enLima(inicio);
    return verificarApertura(d, new Date(d.getTime() + minutos * 60_000), a).abierto;
  };

  it('Chiclayo atiende a las 19:00; la sede por defecto, no', () => {
    expect(cabeEn('chiclayo', '2026-08-03T19:00:00')).toBe(true);
    expect(cabeEn('miraflores', '2026-08-03T19:00:00')).toBe(false);
    expect(cabeEn(undefined, '2026-08-03T19:00:00')).toBe(false);
  });

  it('Chiclayo NO atiende a las 14:00: su pausa se alarga hasta las 15:00', () => {
    expect(cabeEn('chiclayo', '2026-08-03T14:00:00')).toBe(false);
    expect(cabeEn('miraflores', '2026-08-03T14:00:00')).toBe(true);
  });

  it('Primavera atiende el sabado por la tarde; las demas no', () => {
    expect(cabeEn('primavera', '2026-08-08T15:00:00')).toBe(true);
    expect(cabeEn('surco', '2026-08-08T15:00:00')).toBe(false);
  });

  it('una sede sin excepcion usa el horario general', () => {
    expect(cabeEn('comas', '2026-08-03T10:00:00')).toBe(true);
    expect(cabeEn('comas', '2026-08-03T19:30:00')).toBe(false);
  });

  it('el nombre de la sede se normaliza igual que en las herramientas', () => {
    // «Chiclayo», `chiclayo` y «CHICLAYO» son la misma sede.
    expect(cabeEn('CHICLAYO', '2026-08-03T19:00:00')).toBe(true);
    expect(cabeEn('Chiclayo', '2026-08-03T19:00:00')).toBe(true);
  });
});

describe('verificarApertura', () => {
  const cabe = (inicio: string, minutos = 40): boolean =>
    verificarApertura(enLima(inicio), new Date(enLima(inicio).getTime() + minutos * 60_000), agendaReal)
      .abierto;

  it('acepta un horario que cabe entero en un tramo', () => {
    expect(cabe('2026-08-03T10:00:00')).toBe(true); // lunes manana
    expect(cabe('2026-08-03T14:00:00')).toBe(true); // lunes tarde
    expect(cabe('2026-08-08T09:00:00')).toBe(true); // sabado manana
  });

  const rechazos: Array<[string, string]> = [
    ['antes de abrir', '2026-08-03T08:00:00'],
    ['en la pausa de mediodia', '2026-08-03T13:30:00'],
    ['despues de cerrar', '2026-08-03T19:30:00'],
    ['sabado por la tarde', '2026-08-08T15:00:00'],
    ['domingo', '2026-08-09T10:00:00'],
  ];
  for (const [caso, inicio] of rechazos) {
    it(`rechaza ${caso}`, () => {
      expect(cabe(inicio)).toBe(false);
    });
  }

  it('rechaza una cita que empieza dentro pero termina fuera', () => {
    // 12:40 + 40 min = 13:20, ya cerrado. Mirar solo el comienzo --que es lo
    // que hacia el codigo anterior-- la daba por buena.
    expect(cabe('2026-08-03T12:40:00')).toBe(false);
    expect(cabe('2026-08-03T12:20:00')).toBe(true);
  });

  it('rechaza el feriado del 6 de agosto y lo dice con su motivo', () => {
    const inicio = enLima('2026-08-06T10:00:00');
    const veredicto = verificarApertura(inicio, new Date(inicio.getTime() + 40 * 60_000), agendaReal);
    expect(veredicto.abierto).toBe(false);
    expect(veredicto.motivo).toMatch(/Batalla de Junin/);
  });
});

describe('generarCandidatos — de aqui salen los huecos que se ofrecen', () => {
  it('alinea al comienzo de cada tramo y salta la pausa de mediodia', () => {
    const c = generarCandidatos(
      enLima('2026-08-03T00:00:00'),
      enLima('2026-08-04T00:00:00'),
      40,
      agendaReal,
      50,
    );
    const horas = c.map((s) => {
      const l = new Intl.DateTimeFormat('es-PE', {
        timeZone: LIMA,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(s.start);
      return l;
    });

    expect(horas[0]).toBe('09:00');
    // 09:00-13:00 en tramos de 40 son 6; el septimo empezaria a las 13:00.
    expect(horas.slice(0, 6)).toEqual(['09:00', '09:40', '10:20', '11:00', '11:40', '12:20']);
    // La tarde vuelve a empezar en su hora de apertura, no arrastrando el paso.
    expect(horas[6]).toBe('14:00');
    expect(horas).not.toContain('13:00');
    expect(horas).not.toContain('13:20');
  });

  it('no genera nada en feriado', () => {
    const c = generarCandidatos(
      enLima('2026-08-06T00:00:00'),
      enLima('2026-08-07T00:00:00'),
      40,
      agendaReal,
      50,
    );
    expect(c).toHaveLength(0);
  });

  it('una ventana mas corta que la cita ya NO devuelve cero por la rejilla', () => {
    // Este era el fallo que el paciente notaba como «no hay espacio» en un dia
    // entero libre: la rejilla anterior partia [desde, hasta] en pasos de
    // `duracionMin` desde `desde`, asi que una ventana de media hora con citas
    // de 40 minutos no daba ningun hueco. Ahora los candidatos salen del
    // horario de la clinica y se recortan a la ventana, no al reves.
    const c = generarCandidatos(
      enLima('2026-08-03T00:00:00'),
      enLima('2026-08-03T23:59:00'),
      40,
      agendaReal,
      50,
    );
    expect(c.length).toBeGreaterThan(10);
  });

  it('respeta el tope y no se desboca con un rango de 30 dias', () => {
    const c = generarCandidatos(
      enLima('2026-08-03T00:00:00'),
      enLima('2026-09-02T00:00:00'),
      40,
      agendaReal,
      14,
    );
    expect(c).toHaveLength(14);
  });
});

describe('cierresProximos — para poder DECIRLO antes', () => {
  it('lista los feriados de la ventana con su motivo', () => {
    const cierres = cierresProximos(enLima('2026-08-01T09:00:00'), 30, agendaReal);
    expect(cierres).toEqual([{ iso: '2026-08-06', motivo: 'Batalla de Junin' }]);
  });
});

describe('interpretarInstante — entender lo que el modelo manda de verdad', () => {
  /**
   * Casos REALES sacados de la traza del canal de voz. El esquema exigia
   * ISO-8601 con desplazamiento y el modelo alojado mandaba esto; Zod lo
   * rechazaba y el agente le decia al paciente «no tengo acceso al
   * calendario». Ni era falta de acceso ni el paciente podia hacer nada.
   */
  it('una fecha sin hora es el comienzo del dia en la clinica', () => {
    expect(interpretarInstante('2026-08-20', LIMA)?.toISOString()).toBe('2026-08-20T05:00:00.000Z');
  });

  it('la misma fecha como fin de rango es el FINAL de ese dia', () => {
    // El modelo manda la misma fecha en `desde` y `hasta` para decir «el
    // jueves». Tomarla literalmente daba un intervalo vacio y un «no hay
    // disponibilidad» sobre un dia entero libre.
    const fin = interpretarInstante('2026-08-20', LIMA, true);
    expect(fin?.toISOString()).toBe('2026-08-21T04:59:59.999Z');
    const inicio = interpretarInstante('2026-08-20', LIMA, false);
    expect(fin!.getTime()).toBeGreaterThan(inicio!.getTime());
  });

  it('una hora SIN zona se resuelve en la de la clinica, nunca en la del servidor', () => {
    // Es lo que separa una cita correcta de una corrida de horas segun donde
    // este desplegado el proceso.
    expect(interpretarInstante('2026-08-05T00:00:00', LIMA)?.toISOString()).toBe(
      '2026-08-05T05:00:00.000Z',
    );
    expect(interpretarInstante('2026-08-20T09:00', LIMA)?.toISOString()).toBe(
      '2026-08-20T14:00:00.000Z',
    );
    // Con espacio en vez de T tambien: el modelo lo escribe de las dos formas.
    expect(interpretarInstante('2026-08-20 09:00:00', LIMA)?.toISOString()).toBe(
      '2026-08-20T14:00:00.000Z',
    );
  });

  it('un desplazamiento explicito manda sobre la zona de la clinica', () => {
    expect(interpretarInstante('2026-08-20T09:00:00-05:00', LIMA)?.toISOString()).toBe(
      '2026-08-20T14:00:00.000Z',
    );
    expect(interpretarInstante('2026-08-20T14:00:00Z', LIMA)?.toISOString()).toBe(
      '2026-08-20T14:00:00.000Z',
    );
  });

  it('lo que no es una fecha se rechaza, no se adivina', () => {
    for (const basura of ['manana', 'el jueves', '', '   ', 'por la tarde']) {
      expect(interpretarInstante(basura, LIMA)).toBeUndefined();
    }
  });

  it('distingue una fecha sin hora, para no agendar a medianoche', () => {
    expect(esSoloFecha('2026-08-20')).toBe(true);
    expect(esSoloFecha('2026-08-20T10:00:00')).toBe(false);
  });
});

describe('describirInstante — la hora que se le dice al paciente', () => {
  /**
   * REGRESION medida en una llamada real. La herramienta devolvia los huecos
   * como ISO en UTC (`2026-08-05T20:00:00.000Z`) y el agente anunciaba "las
   * ocho de la noche". Eran las TRES DE LA TARDE. Con la clinica cerrando a las
   * siete, ofrecia horarios imposibles y luego no podia agendarlos.
   */
  it('convierte a hora de la clinica, no deja el UTC crudo', () => {
    const texto = describirInstante(new Date('2026-08-05T20:00:00.000Z'), LIMA);
    expect(texto).toMatch(/3:00/);
    expect(texto).toMatch(/p\.?\s?m/i);
    expect(texto).not.toMatch(/\b8:00\b/);
    expect(texto).toMatch(/mi[eé]rcoles/i);
    expect(texto).toMatch(/5 de agosto/);
  });

  it('isoLocal lleva el desplazamiento de la clinica, nunca Z', () => {
    // Es lo que se le devuelve para que lo reenvie a `crear_cita`: si llevara
    // Z, el modelo lo repetiria y la cita saldria cinco horas corrida.
    expect(isoLocal(new Date('2026-08-05T20:00:00.000Z'), LIMA)).toBe('2026-08-05T15:00:00-05:00');
    expect(isoLocal(new Date('2026-08-05T14:00:00.000Z'), LIMA)).toBe('2026-08-05T09:00:00-05:00');
  });

  it('lo que devuelve isoLocal vuelve a entrar sin perder la hora', () => {
    // Ida y vuelta: consultar_agenda -> el modelo -> crear_cita.
    const original = new Date('2026-08-05T20:00:00.000Z');
    const texto = isoLocal(original, LIMA);
    expect(interpretarInstante(texto, LIMA)?.getTime()).toBe(original.getTime());
  });
});

describe('zona horaria de la clinica', () => {
  it('no depende del reloj ni de la zona del servidor', () => {
    // 2026-08-03 10:00 en Lima son las 15:00 UTC. Si esto se rompe, las citas
    // salen corridas, que es el fallo mas caro del sistema.
    const instante = instanteLocal(2026, 8, 3, 10, 0, LIMA);
    expect(instante.toISOString()).toBe('2026-08-03T15:00:00.000Z');

    const local = fechaLocal(instante, LIMA);
    expect(local.iso).toBe('2026-08-03');
    expect(local.diaSemana).toBe(1); // lunes
  });

  it('un instante de madrugada UTC sigue siendo el dia anterior en Lima', () => {
    // 2026-08-07 02:00 UTC son las 21:00 del 6 de agosto en Lima: feriado.
    const local = fechaLocal(new Date('2026-08-07T02:00:00Z'), LIMA);
    expect(local.iso).toBe('2026-08-06');
  });
});
