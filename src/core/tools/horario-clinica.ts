/**
 * HORARIO DE ATENCION DE LA CLINICA.
 *
 * Vive aqui, y no dentro de una herramienta, porque lo necesitan DOS:
 * `consultar_agenda` para no ofrecer un hueco imposible y `crear_cita` para no
 * escribirlo. Si cada una llevara su copia, se separarian: el agente ofreceria
 * un horario que despues su propia herramienta rechaza, que es la peor de las
 * combinaciones para el paciente.
 *
 * POR QUE NO LO RESUELVE EL ADAPTADOR DE CALENDARIO
 * `freebusy` de Google responde que un hueco esta libre, y lo esta: nadie ha
 * reservado las 23:57. Que la clinica no atienda a esa hora es una regla de
 * negocio de la clinica, no un detalle del proveedor. Por eso el filtro es del
 * nucleo y no de `infra/`.
 *
 * ============================================================================
 * DOS VOCABULARIOS, UNO ROTO
 * ============================================================================
 * `crear-cita.tool.ts` leia `clinic.config.horario` (SINGULAR) con la forma
 * `{ horaApertura, horaCierre, diasLaborables }`. La clinica de demostracion
 * —y el formato que documenta la semilla— define `clinic.config.horarios`
 * (PLURAL) con franjas por tipo de dia:
 *
 *     { "lunes_viernes": [["09:00","13:00"], ["15:00","20:00"]],
 *       "sabado":        [["09:00","14:00"]],
 *       "domingo":       [] }
 *
 * El parseo del singular fallaba en silencio y se caia al valor por defecto
 * (lunes a sabado, 08:00-20:00). Consecuencia real: se admitian citas a las
 * 14:00, con la clinica cerrada al mediodia, y a las 08:00, antes de abrir.
 *
 * Aqui se leen LAS DOS formas, con `horarios` teniendo prioridad. El singular
 * se mantiene por compatibilidad, no porque sea deseable.
 *
 * El formato de franjas es ademas el unico que puede expresar un cierre al
 * mediodia. Con `horaApertura`/`horaCierre` la pausa de 13:00 a 15:00 es
 * INEXPRESABLE, y por eso el horario real de la clinica no cabia en el modelo
 * anterior.
 * ============================================================================
 */
import { z } from 'zod';

import type { Clinic, Logger } from '../types/index.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'se espera HH:MM en 24 h');
/** Una franja es [apertura, cierre). Un dia puede tener varias, o ninguna. */
const franja = z.tuple([HHMM, HHMM]);
const franjas = z.array(franja);

/** Formato por franjas. Admite el dia suelto y el grupo `lunes_viernes`. */
const horariosSchema = z
  .object({
    domingo: franjas,
    lunes: franjas,
    martes: franjas,
    miercoles: franjas,
    jueves: franjas,
    viernes: franjas,
    sabado: franjas,
    lunes_viernes: franjas,
  })
  .partial();

/** Formato heredado: una sola franja continua, igual para todos los dias. */
const horarioSimpleSchema = z
  .object({
    horaApertura: HHMM,
    horaCierre: HHMM,
    /** 0=domingo .. 6=sabado (convencion de `Date#getDay`). */
    diasLaborables: z.array(z.number().int().min(0).max(6)).min(1),
  })
  .partial();

/**
 * Ultimo recurso: lunes a sabado, 08:00-20:00.
 *
 * Se usa solo si la clinica no declara horario de ninguna de las dos formas.
 * NO filtrar seria peor —dejaria ofrecer y agendar a cualquier hora— y
 * rechazarlo todo dejaria la clinica sin agenda; un horario conservador y un
 * aviso en el log es el punto medio menos malo. Que aparezca ese aviso
 * significa que a esa clinica le falta configuracion.
 */
const POR_DEFECTO: Record<number, Array<[string, string]>> = {
  0: [],
  1: [['08:00', '20:00']],
  2: [['08:00', '20:00']],
  3: [['08:00', '20:00']],
  4: [['08:00', '20:00']],
  5: [['08:00', '20:00']],
  6: [['08:00', '20:00']],
};

const DIA_A_NUMERO: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const NUMERO_A_CLAVE = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;

const aMinutos = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Franjas de atencion de cada dia de la semana, en minutos desde medianoche y
 * en la zona horaria de la clinica.
 */
export function resolverFranjas(clinic: Clinic, logger?: Logger): Record<number, Array<[number, number]>> {
  const config = clinic.config as Record<string, unknown> | undefined;
  const enMinutos = (lista: Array<[string, string]>): Array<[number, number]> =>
    lista.map(([a, b]) => [aMinutos(a), aMinutos(b)] as [number, number]).filter(([a, b]) => b > a);

  const porFranjas = horariosSchema.safeParse(config?.['horarios']);
  if (porFranjas.success && Object.keys(porFranjas.data).length > 0) {
    const d = porFranjas.data;
    const resultado: Record<number, Array<[number, number]>> = {};
    for (let dia = 0; dia <= 6; dia += 1) {
      // El dia concreto manda sobre el grupo: una clinica puede declarar
      // `lunes_viernes` y ademas un miercoles distinto.
      const propio = d[NUMERO_A_CLAVE[dia] as keyof typeof d];
      const grupo = dia >= 1 && dia <= 5 ? d.lunes_viernes : undefined;
      resultado[dia] = enMinutos(propio ?? grupo ?? []);
    }
    return resultado;
  }

  const simple = horarioSimpleSchema.safeParse(config?.['horario']);
  if (simple.success && simple.data.horaApertura && simple.data.horaCierre) {
    const laborables = simple.data.diasLaborables ?? [1, 2, 3, 4, 5, 6];
    const rango: [number, number] = [aMinutos(simple.data.horaApertura), aMinutos(simple.data.horaCierre)];
    const resultado: Record<number, Array<[number, number]>> = {};
    for (let dia = 0; dia <= 6; dia += 1) resultado[dia] = laborables.includes(dia) ? [rango] : [];
    return resultado;
  }

  logger?.warn(
    { clinicId: clinic.id },
    'la clinica no declara horario (ni `horarios` ni `horario`) en config; se usa el conservador por defecto 08:00-20:00 de lunes a sabado',
  );
  const resultado: Record<number, Array<[number, number]>> = {};
  for (let dia = 0; dia <= 6; dia += 1) resultado[dia] = enMinutos(POR_DEFECTO[dia] ?? []);
  return resultado;
}

/** Dia de la semana y minuto del dia de un instante, en la zona de la clinica. */
function enZonaDeLaClinica(instante: Date, timezone: string): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(instante);
  const valor = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '';
  // `hour12: false` puede dar "24" a medianoche en algunos entornos; 24:00 y
  // 00:00 son el mismo instante y el dia ya viene resuelto aparte.
  const hora = Number(valor('hour')) % 24;
  return { dia: DIA_A_NUMERO[valor('weekday')] ?? -1, minutos: hora * 60 + Number(valor('minute')) };
}

/**
 * True si la cita COMPLETA cabe dentro de una sola franja de atencion.
 *
 * Se comprueba el intervalo entero, no solo el inicio: una cita de 40 minutos
 * a las 19:50 empieza dentro del horario y termina veinte minutos despues del
 * cierre. Comprobar solo el inicio es el error que hace que el ultimo paciente
 * del dia se quede a solas con la puerta cerrada.
 *
 * Tampoco se admite una cita a caballo entre dos franjas: de 12:40 a 13:20 con
 * cierre al mediodia no es media cita, es una cita imposible.
 */
export function citaDentroDeHorario(
  inicio: Date,
  duracionMin: number,
  clinic: Clinic,
  logger?: Logger,
  franjasPrecalculadas?: Record<number, Array<[number, number]>>,
): boolean {
  if (duracionMin <= 0) return false;
  const franjasPorDia = franjasPrecalculadas ?? resolverFranjas(clinic, logger);
  const { dia, minutos } = enZonaDeLaClinica(inicio, clinic.timezone);
  if (dia < 0) return false;
  const fin = minutos + duracionMin;
  return (franjasPorDia[dia] ?? []).some(([abre, cierra]) => minutos >= abre && fin <= cierra);
}

/** Descripcion legible del horario, para mensajes de error y para el log. */
export function describirHorario(clinic: Clinic, logger?: Logger): string {
  const franjasPorDia = resolverFranjas(clinic, logger);
  const aTexto = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const partes: string[] = [];
  for (let dia = 0; dia <= 6; dia += 1) {
    const lista = franjasPorDia[dia] ?? [];
    const nombre = NUMERO_A_CLAVE[dia];
    partes.push(lista.length === 0 ? `${nombre}: cerrado` : `${nombre}: ${lista.map(([a, b]) => `${aTexto(a)}-${aTexto(b)}`).join(' y ')}`);
  }
  return partes.join(' · ');
}
