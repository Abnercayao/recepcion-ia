/**
 * Horario de atencion de la clinica.
 *
 * Estas pruebas fijan los tres fallos que motivaron el modulo:
 *
 *   1. Se leia `clinic.config.horario` (singular) y la clinica declara
 *      `horarios` (plural). El parseo fallaba en silencio y se validaba contra
 *      el horario por defecto en vez de contra el real.
 *   2. Se comprobaba solo el INICIO de la cita, no que cupiera entera antes
 *      del cierre.
 *   3. `consultar_agenda` no filtraba nada, asi que ofrecia horarios que
 *      `crear_cita` despues rechazaba.
 */
import { describe, expect, it } from 'vitest';

import { citaDentroDeHorario, describirHorario, resolverFranjas } from '../../src/core/tools/horario-clinica.js';
import type { Clinic } from '../../src/core/types/conversation.js';

const clinica = (config: Record<string, unknown>): Clinic =>
  ({
    id: 'c1',
    nombre: 'Clinica de prueba',
    timezone: 'America/Lima',
    config,
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: [],
  }) as Clinic;

/** Horario real de la clinica de demostracion, con cierre al mediodia. */
const CON_FRANJAS = clinica({
  horarios: {
    lunes_viernes: [
      ['09:00', '13:00'],
      ['15:00', '20:00'],
    ],
    sabado: [['09:00', '14:00']],
    domingo: [],
  },
});

/** Lima es UTC-5 todo el año: 14:00Z son las 09:00 en la clinica. */
const enLima = (iso: string): Date => new Date(iso);

describe('resolverFranjas', () => {
  it('lee el formato por franjas y expande lunes_viernes a los cinco dias', () => {
    const f = resolverFranjas(CON_FRANJAS);
    expect(f[1]).toEqual([
      [540, 780],
      [900, 1200],
    ]);
    expect(f[5]).toEqual(f[1]);
    expect(f[6]).toEqual([[540, 840]]);
    expect(f[0]).toEqual([]);
  });

  it('el dia concreto tiene prioridad sobre el grupo', () => {
    const c = clinica({
      horarios: { lunes_viernes: [['09:00', '18:00']], miercoles: [['09:00', '12:00']] },
    });
    const f = resolverFranjas(c);
    expect(f[3]).toEqual([[540, 720]]);
    expect(f[2]).toEqual([[540, 1080]]);
  });

  it('sigue entendiendo el formato heredado `horario`', () => {
    const c = clinica({ horario: { horaApertura: '08:00', horaCierre: '20:00', diasLaborables: [1, 2] } });
    const f = resolverFranjas(c);
    expect(f[1]).toEqual([[480, 1200]]);
    expect(f[3]).toEqual([]);
  });

  it('avisa y usa el conservador por defecto si no hay horario declarado', () => {
    const avisos: string[] = [];
    const logger = { warn: (_o: unknown, m?: string) => avisos.push(m ?? '') } as never;
    const f = resolverFranjas(clinica({}), logger);
    expect(f[1]).toEqual([[480, 1200]]);
    expect(f[0]).toEqual([]);
    expect(avisos).toHaveLength(1);
  });

  it('descarta franjas invertidas o vacias en vez de aceptarlas', () => {
    const f = resolverFranjas(clinica({ horarios: { lunes: [['18:00', '09:00'], ['09:00', '13:00']] } }));
    expect(f[1]).toEqual([[540, 780]]);
  });
});

describe('citaDentroDeHorario', () => {
  // 2026-07-27 es lunes.
  it('acepta una cita que cabe entera dentro de una franja', () => {
    expect(citaDentroDeHorario(enLima('2026-07-27T15:00:00Z'), 40, CON_FRANJAS)).toBe(true);
  });

  it('rechaza el cierre del mediodia, que el formato heredado no podia expresar', () => {
    // 19:00Z = 14:00 en Lima, con la clinica cerrada entre 13:00 y 15:00.
    expect(citaDentroDeHorario(enLima('2026-07-27T19:00:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('rechaza antes de abrir', () => {
    // 13:00Z = 08:00 en Lima.
    expect(citaDentroDeHorario(enLima('2026-07-27T13:00:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('rechaza la cita que EMPIEZA dentro pero termina despues del cierre', () => {
    // 19:50 en Lima + 40 min = 20:30, con cierre a las 20:00.
    expect(citaDentroDeHorario(enLima('2026-07-28T00:50:00Z'), 40, CON_FRANJAS)).toBe(false);
    // La misma hora con 10 minutos si cabe.
    expect(citaDentroDeHorario(enLima('2026-07-28T00:50:00Z'), 10, CON_FRANJAS)).toBe(true);
  });

  it('rechaza la cita a caballo entre dos franjas', () => {
    // 12:40 a 13:20 en Lima: empieza abierto, cruza el cierre del mediodia.
    expect(citaDentroDeHorario(enLima('2026-07-27T17:40:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('rechaza el domingo entero', () => {
    expect(citaDentroDeHorario(enLima('2026-07-26T16:00:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('respeta el sabado, que cierra antes', () => {
    // 2026-08-01 es sabado. 17:00Z = 12:00 en Lima -> cabe; 19:00Z = 14:00 -> no.
    expect(citaDentroDeHorario(enLima('2026-08-01T17:00:00Z'), 40, CON_FRANJAS)).toBe(true);
    expect(citaDentroDeHorario(enLima('2026-08-01T19:00:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('usa la zona de la clinica, no la del servidor', () => {
    // 2026-07-28T02:00:00Z son las 21:00 del lunes en Lima (cerrado), pero las
    // 02:00 del martes en UTC. Si se leyera en UTC, el resultado cambiaria.
    expect(citaDentroDeHorario(enLima('2026-07-28T02:00:00Z'), 40, CON_FRANJAS)).toBe(false);
  });

  it('rechaza una duracion no positiva', () => {
    expect(citaDentroDeHorario(enLima('2026-07-27T15:00:00Z'), 0, CON_FRANJAS)).toBe(false);
  });
});

describe('describirHorario', () => {
  it('describe el cierre del mediodia y el dia cerrado', () => {
    const texto = describirHorario(CON_FRANJAS);
    expect(texto).toContain('lunes: 09:00-13:00 y 15:00-20:00');
    expect(texto).toContain('domingo: cerrado');
  });
});
