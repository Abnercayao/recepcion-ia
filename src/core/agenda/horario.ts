/**
 * CUANDO ATIENDE LA CLINICA: horario real, tramos y feriados.
 *
 * Nace de tres defectos medidos, los tres de la misma familia --el codigo leia
 * una clave de configuracion que la semilla no tiene-- y los tres con el mismo
 * modo de fallo: en vez de avisar, se aplicaba un valor por defecto inventado y
 * el agente agendaba mal con total aplomo.
 *
 *   1. `crear-cita.tool.ts` leia `clinic.config.horario` (SINGULAR), con forma
 *      `{horaApertura, horaCierre, diasLaborables}`. La semilla tiene
 *      `horarios` (PLURAL), con tramos por dia y pausa de mediodia. Nunca
 *      casaban, asi que se aplicaba el defecto 08:00-20:00 de lunes a sabado y
 *      se podia agendar a las 08:00 (abre a las 9), dentro de la pausa de
 *      13:00-14:00, a las 19:30 (cierra a las 19) y el sabado por la tarde
 *      (cierra a las 13). Es el criterio BLOQUEANTE de la Tabla 14: "citas
 *      creadas con fecha, hora o profesional incorrectos = 0".
 *
 *   2. No existia el concepto de FERIADO en ninguna capa. El 6 de agosto
 *      --Batalla de Junin-- ninguna sede atiende, y el agente agendaba igual.
 *
 *   3. La disponibilidad no sabia nada de horario: ofrecia huecos de madrugada
 *      si el rango consultado los incluia.
 *
 * POR QUE VIVE EN EL NUCLEO Y NO EN EL ADAPTADOR DE CALENDARIO
 * Porque hay dos implementaciones de `CalendarPort` --Google y el doble de
 * demostracion-- y el horario de la clinica no es un detalle de Google: es
 * regla de negocio. Puesta aqui, la cumplen las dos por construccion. Puesta en
 * el cliente de Google, la web de demostracion seguiria ofreciendo domingos.
 *
 * SOBRE LAS ZONAS HORARIAS
 * Todo el modulo razona en la hora LOCAL DE LA CLINICA y devuelve instantes
 * absolutos (`Date`). Nunca se usa el reloj ni la zona del servidor: el
 * servidor puede estar en cualquier sitio y una cita corrida una hora es el
 * fallo mas caro que puede cometer este sistema.
 */
import { z } from 'zod';
import type { Clinic } from '../types/conversation.js';
import type { Logger } from '../types/ports.js';

// ---------------------------------------------------------------------------
// Zona horaria
// ---------------------------------------------------------------------------

/** Desfase de una zona respecto de UTC, en ms, PARA ESE INSTANTE (respeta DST). */
function desfaseDeZonaMs(instante: Date, timeZone: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instante);

  const leer = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value ?? '0');
  // `hour` puede venir como 24 en algunos entornos con hour12:false.
  const comoSiFueraUtc = Date.UTC(
    leer('year'),
    leer('month') - 1,
    leer('day'),
    leer('hour') % 24,
    leer('minute'),
    leer('second'),
  );
  return comoSiFueraUtc - instante.getTime();
}

/**
 * Instante absoluto de una fecha y hora LOCALES de la clinica.
 *
 * Dos pasos, no uno: se tantea en UTC, se mide el desfase real de la zona para
 * ese momento del ano y se corrige. Perú no tiene horario de verano, pero
 * hacerlo bien aqui cuesta cuatro lineas y evita que la primera clinica con DST
 * agende con una hora de diferencia.
 */
export function instanteLocal(
  anio: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  timeZone: string,
): Date {
  const tanteo = Date.UTC(anio, mes - 1, dia, hora, minuto);
  const desfase = desfaseDeZonaMs(new Date(tanteo), timeZone);
  return new Date(tanteo - desfase);
}

/** Fecha local de la clinica: `{anio, mes, dia, diaSemana}` con 0=domingo. */
export function fechaLocal(
  instante: Date,
  timeZone: string,
): { anio: number; mes: number; dia: number; diaSemana: number; iso: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instante);

  const leer = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '';
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const anio = Number(leer('year'));
  const mes = Number(leer('month'));
  const dia = Number(leer('day'));

  return {
    anio,
    mes,
    dia,
    diaSemana: dias[leer('weekday')] ?? 0,
    iso: `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------------
// Configuracion: lo que de verdad hay en `clinic.config`
// ---------------------------------------------------------------------------

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const tramoSchema = z.tuple([z.string().regex(HH_MM), z.string().regex(HH_MM)]);

/**
 * Forma REAL de la semilla: `horarios` con un grupo de dias por clave.
 *
 *   "horarios": {
 *     "lunes_viernes": [["09:00","13:00"], ["14:00","19:00"]],
 *     "sabado":        [["09:00","13:00"]],
 *     "domingo":       []
 *   }
 *
 * La pausa de mediodia no es un adorno: sin ella el agente agenda a las 13:30,
 * cuando no hay nadie.
 */
const horariosSchema = z.record(z.string(), z.array(tramoSchema));

/** Forma antigua, en singular. Se mantiene porque hay clinicas y tests con ella. */
const horarioLegadoSchema = z
  .object({
    horaApertura: z.string().regex(HH_MM),
    horaCierre: z.string().regex(HH_MM),
    diasLaborables: z.array(z.number().int().min(0).max(6)).min(1),
  })
  .partial();

const feriadoSchema = z.union([
  z.string(),
  z.object({ fecha: z.string(), motivo: z.string().optional() }),
]);

/** Claves de `horarios` -> dias de la semana (0=domingo). */
const GRUPOS_DE_DIAS: Record<string, number[]> = {
  domingo: [0],
  lunes: [1],
  martes: [2],
  miercoles: [3],
  jueves: [4],
  viernes: [5],
  sabado: [6],
  lunes_viernes: [1, 2, 3, 4, 5],
  lunes_sabado: [1, 2, 3, 4, 5, 6],
  lunes_domingo: [0, 1, 2, 3, 4, 5, 6],
  entre_semana: [1, 2, 3, 4, 5],
  fin_de_semana: [0, 6],
};

export interface Tramo {
  /** Minutos desde medianoche, hora local de la clinica. */
  desde: number;
  hasta: number;
}

export interface AgendaDeClinica {
  /** dia de la semana (0=domingo) -> tramos abiertos. Vacio = cerrado. */
  porDia: Map<number, Tramo[]>;
  /** `YYYY-MM-DD` -> motivo. La clinica no atiende ese dia. */
  feriados: Map<string, string>;
  /** Duracion por defecto de una cita, en minutos. */
  duracionCitaMin: number;
  timeZone: string;
  /** True si el horario salio de la configuracion; false si es el de respaldo. */
  configurado: boolean;
}

function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Horario de respaldo, y se DECLARA como tal.
 *
 * Antes el respaldo era 08:00-20:00 de lunes a sabado y se aplicaba en
 * silencio, que es lo que dejaba agendar fuera de hora sin que nadie se
 * enterara. Ahora es deliberadamente ESTRECHO --el nucleo comun de casi
 * cualquier clinica-- y `configurado: false` permite que quien lo use avise.
 * Ante la duda, cerrar de mas: una cita perdida se recupera; un paciente
 * plantado delante de una puerta cerrada, no.
 */
const RESPALDO: Tramo[] = [{ desde: aMinutos('09:00'), hasta: aMinutos('13:00') }];

export function resolverAgenda(clinic: Clinic, logger?: Logger): AgendaDeClinica {
  const config = (clinic.config ?? {}) as Record<string, unknown>;
  const porDia = new Map<number, Tramo[]>();
  let configurado = false;

  const plural = horariosSchema.safeParse(config['horarios']);
  if (plural.success && Object.keys(plural.data).length > 0) {
    configurado = true;
    for (const [clave, tramos] of Object.entries(plural.data)) {
      const dias = GRUPOS_DE_DIAS[clave.toLowerCase().replace(/[\s-]/g, '_')];
      if (!dias) {
        logger?.warn(
          { clinicId: clinic.id, clave },
          'clave de horarios desconocida: ese grupo de dias se ignora',
        );
        continue;
      }
      const normalizados = tramos
        .map(([d, h]) => ({ desde: aMinutos(d), hasta: aMinutos(h) }))
        .filter((t) => t.hasta > t.desde)
        .sort((a, b) => a.desde - b.desde);
      for (const dia of dias) porDia.set(dia, normalizados);
    }
  }

  if (!configurado) {
    const legado = horarioLegadoSchema.safeParse(config['horario']);
    if (legado.success && legado.data.horaApertura && legado.data.horaCierre) {
      configurado = true;
      const tramo = {
        desde: aMinutos(legado.data.horaApertura),
        hasta: aMinutos(legado.data.horaCierre),
      };
      for (const dia of legado.data.diasLaborables ?? [1, 2, 3, 4, 5, 6]) porDia.set(dia, [tramo]);
    }
  }

  if (!configurado) {
    logger?.warn(
      { clinicId: clinic.id },
      'la clinica no declara horario (`horarios` ni `horario`): se usa el de respaldo, deliberadamente estrecho',
    );
    for (const dia of [1, 2, 3, 4, 5]) porDia.set(dia, RESPALDO);
  }

  // Los dias no mencionados estan CERRADOS. Es lo contrario del defecto
  // anterior, que abria por omision.
  for (const dia of [0, 1, 2, 3, 4, 5, 6]) if (!porDia.has(dia)) porDia.set(dia, []);

  const feriados = new Map<string, string>();
  const crudos = z.array(feriadoSchema).safeParse(config['feriados']);
  if (crudos.success) {
    for (const f of crudos.data) {
      if (typeof f === 'string') feriados.set(f.trim(), 'feriado');
      else feriados.set(f.fecha.trim(), f.motivo?.trim() ?? 'feriado');
    }
  }

  const duracion = Number(config['duracion_cita_min']);

  return {
    porDia,
    feriados,
    duracionCitaMin: Number.isFinite(duracion) && duracion > 0 ? duracion : 30,
    timeZone: clinic.timezone,
    configurado,
  };
}

// ---------------------------------------------------------------------------
// Preguntas que hace el resto del sistema
// ---------------------------------------------------------------------------

export interface VeredictoDeApertura {
  abierto: boolean;
  /** Por que NO, en lenguaje que el modelo pueda repetirle al paciente. */
  motivo?: string;
}

/** Si ese dia es feriado, devuelve el motivo. */
export function feriadoDe(instante: Date, agenda: AgendaDeClinica): string | undefined {
  return agenda.feriados.get(fechaLocal(instante, agenda.timeZone).iso);
}

/**
 * Comprueba que el intervalo [inicio, fin) cae ENTERO dentro de un mismo tramo
 * abierto y que el dia no es feriado.
 *
 * Entero y en un mismo tramo a proposito: una cita de 40 minutos que empieza a
 * las 12:40 termina a las 13:20, con la clinica ya cerrada. Comprobar solo el
 * comienzo --que es lo que se hacia-- la daba por buena.
 */
export function verificarApertura(
  inicio: Date,
  fin: Date,
  agenda: AgendaDeClinica,
): VeredictoDeApertura {
  const motivoFeriado = feriadoDe(inicio, agenda);
  if (motivoFeriado !== undefined) {
    return { abierto: false, motivo: `es feriado (${motivoFeriado}) y ninguna sede atiende` };
  }

  const local = fechaLocal(inicio, agenda.timeZone);
  const tramos = agenda.porDia.get(local.diaSemana) ?? [];
  if (tramos.length === 0) {
    return { abierto: false, motivo: 'ese dia la clinica no atiende' };
  }

  const medianoche = instanteLocal(local.anio, local.mes, local.dia, 0, 0, agenda.timeZone);
  const minutosInicio = (inicio.getTime() - medianoche.getTime()) / 60_000;
  const minutosFin = (fin.getTime() - medianoche.getTime()) / 60_000;

  const cabe = tramos.some((t) => minutosInicio >= t.desde && minutosFin <= t.hasta);
  if (!cabe) {
    const horario = tramos
      .map((t) => `${formatearMinutos(t.desde)}-${formatearMinutos(t.hasta)}`)
      .join(' y ');
    return {
      abierto: false,
      motivo: `la cita completa no cabe en el horario de ese dia (${horario})`,
    };
  }
  return { abierto: true };
}

export function formatearMinutos(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Horarios en los que la clinica PODRIA atender dentro del rango, alineados al
 * comienzo de cada tramo.
 *
 * Es lo que sustituye a la rejilla ciega que tenia `findAvailableSlots`: aquella
 * se anclaba en el `desde` que mandara el modelo --a menudo una hora arbitraria
 * como las 09:17-- y avanzaba a pasos fijos cruzando el cierre y la pausa de
 * mediodia. Ademas, si la ventana pedida era mas corta que la duracion de la
 * cita, devolvia CERO huecos y el agente le decia al paciente que no habia
 * espacio en un dia entero libre.
 *
 * Aqui los candidatos nacen del horario de la clinica, no de lo que pida el
 * modelo: cada tramo empieza en su hora de apertura y se rellena hasta que la
 * siguiente cita ya no cabe entera.
 */
export function generarCandidatos(
  desde: Date,
  hasta: Date,
  duracionMin: number,
  agenda: AgendaDeClinica,
  maximo: number,
): Array<{ start: Date; end: Date }> {
  const candidatos: Array<{ start: Date; end: Date }> = [];
  const pasoMs = duracionMin * 60_000;
  if (pasoMs <= 0) return candidatos;

  // Se recorre dia a dia en hora LOCAL, no en saltos de 24 h sobre el epoch:
  // con cambio de hora, 24 h no siempre son un dia.
  let cursor = desde;
  let guarda = 0;

  while (cursor.getTime() < hasta.getTime() && candidatos.length < maximo && guarda < 90) {
    guarda += 1;
    const local = fechaLocal(cursor, agenda.timeZone);
    const medianoche = instanteLocal(local.anio, local.mes, local.dia, 0, 0, agenda.timeZone);

    if (feriadoDe(cursor, agenda) === undefined) {
      for (const tramo of agenda.porDia.get(local.diaSemana) ?? []) {
        for (let m = tramo.desde; m + duracionMin <= tramo.hasta; m += duracionMin) {
          const start = new Date(medianoche.getTime() + m * 60_000);
          const end = new Date(start.getTime() + pasoMs);
          if (start.getTime() < desde.getTime()) continue;
          if (end.getTime() > hasta.getTime()) break;
          candidatos.push({ start, end });
          if (candidatos.length >= maximo) return candidatos;
        }
      }
    }

    // Medianoche del dia siguiente, en hora local.
    cursor = instanteLocal(local.anio, local.mes, local.dia + 1, 0, 0, agenda.timeZone);
  }

  return candidatos;
}

/**
 * Los proximos dias cerrados dentro de una ventana, para que el modelo pueda
 * DECIRLO antes de que el paciente proponga esa fecha.
 *
 * Sin esto, el unico control posible es rechazar la cita cuando ya se pidio, y
 * la conversacion se vuelve un tira y afloja: el paciente propone el jueves, se
 * le dice que no, propone otra cosa. Es la diferencia entre un agente que
 * informa y uno que solo valida.
 */
export function cierresProximos(
  desde: Date,
  dias: number,
  agenda: AgendaDeClinica,
): Array<{ iso: string; motivo: string }> {
  const salida: Array<{ iso: string; motivo: string }> = [];
  const inicio = fechaLocal(desde, agenda.timeZone);

  for (let i = 0; i < dias; i += 1) {
    const dia = instanteLocal(inicio.anio, inicio.mes, inicio.dia + i, 12, 0, agenda.timeZone);
    const local = fechaLocal(dia, agenda.timeZone);
    const motivo = agenda.feriados.get(local.iso);
    if (motivo !== undefined) {
      salida.push({ iso: local.iso, motivo });
    }
  }
  return salida;
}
