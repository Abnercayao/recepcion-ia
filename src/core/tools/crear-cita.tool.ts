import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { CalendarEvent, CalendarPort, Logger, ToolCallRepository } from '../types/ports.js';
import type { Clinic, TurnContext } from '../types/conversation.js';
import {
  FORMATO_DE_FECHA_ESPERADO,
  esSoloFecha,
  interpretarInstante,
  resolverAgenda,
  verificarApertura,
} from '../agenda/horario.js';
import { maskArgsForLog } from './tool.registry.js';

export const DURACION_MIN_MINUTOS = 15;
export const DURACION_MAX_MINUTOS = 180;

/**
 * Maximo de citas por conversacion: 5.
 *
 * `BusinessTool.maxCallsPerConversation` es el unico contador que hace
 * cumplir el registro (ver `tool.registry.ts`), y `ToolCallRepository.countByTool`
 * no distingue llamadas exitosas de fallidas. Este numero cubre, a la vez,
 * "cuantas veces se puede INTENTAR crear_cita" y, en la practica, "cuantas
 * citas puede dejar creadas un mismo paciente en una misma conversacion":
 * 5 intentos alcanzan para 1-2 citas reales (el paciente y, como mucho, un
 * acompanante) mas margen para 2-3 reintentos por colision de horario antes
 * de que el registro corte el paso. Si se agota sin exito, la conversacion
 * debe derivar a la recepcion humana en vez de seguir insistiendo.
 */
export const MAXIMO_CITAS_POR_CONVERSACION = 5;

export const crearCitaInputSchema = z.object({
  /**
   * Cadena, e interpretada despues en la zona de la clinica.
   *
   * Aqui la tolerancia importa MAS que en la consulta: si un texto sin zona se
   * resolviera con el reloj del servidor, la cita quedaria a otra hora. Ver
   * `interpretarInstante`, que nunca delega eso en `new Date`.
   */
  inicio: z
    .string()
    .min(4)
    .describe(`Fecha y hora de comienzo de la cita. ${FORMATO_DE_FECHA_ESPERADO}`),
  duracionMin: z
    .number()
    .int()
    .min(DURACION_MIN_MINUTOS)
    .max(DURACION_MAX_MINUTOS)
    .default(30)
    .describe('Duracion en minutos.'),
  motivo: z.string().min(1).max(200).optional().describe('Motivo de la cita, en pocas palabras.'),
  profesional: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Profesional solicitado. NUNCA pongas aqui la sede.'),
  /**
   * SEDE. Requerida, y no por burocracia.
   *
   * La clinica tiene 24 sedes y este campo no existia: el agente agendaba sin
   * preguntar en cual, y el paciente se presentaba donde no era. Una cita con
   * el lugar equivocado es tan inutil como una con la hora equivocada, y la
   * Tabla 14 trata eso como criterio bloqueante.
   *
   * Al ser requerida en el ESQUEMA, un intento de agendar sin sede no llega a
   * tocar el calendario: lo corta Zod. Es la unica forma de que "pregunta la
   * sede" no dependa de que el modelo se acuerde.
   */
  sede: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'Sede en la que se atiende el paciente. OBLIGATORIA: preguntasela si no la ha dicho. Cada sede tiene su propia agenda.',
    ),
  /**
   * Debe llegar exactamente `true`. Si el campo viene `false`, ausente, o con
   * cualquier otro valor, `z.literal(true)` hace que `safeParse` falle antes
   * de que el resto del codigo se ejecute: el rechazo por falta de
   * confirmacion ocurre en la capa de validacion, no en un `if` que se pueda
   * saltar.
   */
  confirmadoPorPaciente: z.literal(true),
});

/**
 * Normaliza un nombre de sede para compararlo: sin tildes, sin mayusculas y
 * sin separadores. Asi «San Juan de Lurigancho - Zárate», «sjl-zarate» y
 * «SJL Zarate» son la misma sede.
 */
function normalizarSede(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Sedes declaradas por la clinica, propias y franquicias. */
export function sedesDeLaClinica(clinic: Clinic): string[] {
  const config = (clinic.config ?? {}) as Record<string, unknown>;
  const nombres: string[] = [];
  for (const clave of ['sedes_informativas', 'sedes_franquicia']) {
    const grupo = config[clave];
    if (grupo !== null && typeof grupo === 'object') nombres.push(...Object.keys(grupo));
  }
  return nombres;
}

/** Devuelve el nombre canonico de la sede, o `undefined` si no existe. */
export function resolverSede(pedida: string, clinic: Clinic): string | undefined {
  const disponibles = sedesDeLaClinica(clinic);
  // Sin sedes declaradas no se puede validar; se acepta lo que diga el modelo
  // en vez de bloquear el agendamiento de una clinica de sede unica.
  if (disponibles.length === 0) return pedida.trim();

  const objetivo = normalizarSede(pedida);
  if (objetivo === '') return undefined;

  const exacta = disponibles.find((s) => normalizarSede(s) === objetivo);
  if (exacta) return exacta;

  // Coincidencia por inclusion: el paciente dice «Zarate» y la sede es
  // «sjl-zarate». Solo vale si es INEQUIVOCA; con dos candidatas hay que
  // preguntar, no elegir por el paciente.
  const parciales = disponibles.filter(
    (s) => normalizarSede(s).includes(objetivo) || objetivo.includes(normalizarSede(s)),
  );
  return parciales.length === 1 ? parciales[0] : undefined;
}
export type CrearCitaInput = z.infer<typeof crearCitaInputSchema>;

export interface CrearCitaOutput {
  evento: CalendarEvent;
}

export class CrearCitaTool implements BusinessTool<CrearCitaInput, CrearCitaOutput> {
  readonly name = 'crear_cita' as const;
  readonly description =
    'Crea una cita en la agenda de la clinica. SOLO se puede llamar despues de que el paciente confirmo ' +
    'explicitamente fecha y hora (confirmadoPorPaciente=true) Y dijo en QUE SEDE quiere atenderse; si falta ' +
    'cualquiera de las dos cosas, preguntala antes en vez de llamar a esta herramienta. ' +
    'Rechaza fechas pasadas, feriados, horarios fuera de atencion, sedes que no existen y horarios ya ocupados.';
  readonly input = crearCitaInputSchema;
  readonly maxCallsPerConversation = MAXIMO_CITAS_POR_CONVERSACION;

  constructor(
    private readonly calendarPort: CalendarPort,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {}

  async execute(args: CrearCitaInput, ctx: TurnContext): Promise<ToolResult<CrearCitaOutput>> {
    const empezado = Date.now();
    const parsed = this.input.safeParse(args);
    if (!parsed.success) {
      const falta = (campo: string): boolean => parsed.error.issues.some((i) => i.path[0] === campo);
      let error: string;
      if (falta('confirmadoPorPaciente')) {
        error =
          'no se puede crear la cita sin confirmacion explicita del paciente (confirmadoPorPaciente debe ser true)';
      } else if (falta('sede')) {
        error =
          'falta la sede: preguntale al paciente en cual de las sedes quiere atenderse antes de agendar. ' +
          `Sedes disponibles: ${sedesDeLaClinica(ctx.clinic).join(', ') || '(la clinica no las declara)'}`;
      } else {
        error = `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
      }
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, { error });
    }

    const clinicId = ctx.clinic.id; // jamas de los argumentos del modelo
    const { duracionMin, motivo, profesional } = parsed.data;

    // En la zona de la CLINICA. Nunca `new Date(texto)` sobre un texto sin
    // zona: lo resolveria con el reloj del servidor y la cita quedaria a otra
    // hora, que es criterio bloqueante de la Tabla 14.
    const inicioDate = interpretarInstante(parsed.data.inicio, ctx.clinic.timezone, false);
    if (inicioDate === undefined) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: `no entiendo la fecha de "inicio". ${FORMATO_DE_FECHA_ESPERADO}`,
      });
    }
    if (esSoloFecha(parsed.data.inicio)) {
      // Una fecha sin hora no es una cita: agendarla a medianoche seria peor
      // que rechazarla, y el paciente no habria confirmado ninguna hora.
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error:
          'falta la HORA de la cita: "inicio" trae solo la fecha. Confirma la hora con el paciente y mandala como "2026-08-20T10:00:00".',
      });
    }
    const finDate = new Date(inicioDate.getTime() + duracionMin * 60_000);

    if (inicioDate.getTime() <= ctx.now.getTime()) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: 'no se puede agendar una cita en el pasado',
      });
    }

    // La sede tiene que EXISTIR. Aceptar «la de Magdalena» --que no hay-- y
    // grabarla en el evento manda al paciente a una direccion inventada.
    const sede = resolverSede(parsed.data.sede, ctx.clinic);
    if (sede === undefined) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error:
          `la sede "${parsed.data.sede}" no existe o es ambigua. Preguntale al paciente cual prefiere. ` +
          `Sedes disponibles: ${sedesDeLaClinica(ctx.clinic).join(', ')}`,
      });
    }

    /**
     * Horario y feriados, con la agenda REAL de la clinica.
     *
     * Antes se leia `clinic.config.horario`, una clave que la semilla no tiene
     * --tiene `horarios`--, asi que siempre se caia a un defecto de 08:00-20:00
     * de lunes a sabado: se podia agendar antes de abrir, en la pausa de
     * mediodia, despues de cerrar y el sabado por la tarde. Y no habia ningun
     * concepto de feriado, asi que el 6 de agosto se agendaba igual.
     */
    const agenda = resolverAgenda(ctx.clinic, this.logger);
    const apertura = verificarApertura(inicioDate, finDate, agenda);
    if (!apertura.abierto) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: `no se puede agendar en ese horario: ${apertura.motivo ?? 'la clinica no atiende'}`,
      });
    }

    // Segunda verificacion de colision: se hace AQUI, inmediatamente antes de
    // createEvent, no antes. Cualquier confirmacion del paciente o consulta
    // previa a consultar_agenda puede haber quedado obsoleta (otra
    // conversacion pudo tomar el mismo horario mientras tanto); el unico
    // chequeo que cuenta es el que ocurre justo antes de escribir.
    let libre: boolean;
    try {
      // Sobre la agenda DE ESA SEDE. Comprobarlo contra una agenda compartida
      // rechazaba citas legitimas: que Comas estuviera lleno bloqueaba
      // Miraflores.
      libre = await this.calendarPort.isSlotFree(clinicId, inicioDate, finDate, sede);
    } catch (err) {
      this.logger.error({ err: String(err), clinicId }, 'fallo verificando colision antes de crear la cita');
      return this.registrar(ctx, parsed.data, 'error', empezado, {
        error: 'no se pudo verificar la disponibilidad en este momento',
      });
    }
    if (!libre) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: 'el horario ya no esta disponible; consulta la agenda de nuevo y propon otro horario al paciente',
      });
    }

    try {
      /**
       * La cita se crea CON su sede y CON su paciente.
       *
       * El titulo es lo que se lee de un vistazo en el calendario y los campos
       * de paciente son lo que permite reprogramar o confirmar: sin telefono no
       * se sabe a quien llamar. Antes ni la sede ni el paciente llegaban al
       * evento, asi que recepcion veia «Cita» a secas.
       */
      const nombre = ctx.patient.nombre?.trim();
      const evento = await this.calendarPort.createEvent(
        clinicId,
        {
          start: inicioDate,
          end: finDate,
          titulo: `${motivo ?? 'Cita'} · ${nombre ?? ctx.patient.telefonoE164} · sede ${sede}`,
          profesional,
          sede,
          pacienteTelefono: ctx.patient.telefonoE164,
          ...(nombre ? { pacienteNombre: nombre } : {}),
        },
        ctx.patient.telefonoE164,
        sede,
      );
      return this.registrar(ctx, parsed.data, 'ok', empezado, { data: { evento } });
    } catch (err) {
      this.logger.error({ err: String(err), clinicId }, 'fallo creando la cita en el calendario');
      return this.registrar(ctx, parsed.data, 'error', empezado, {
        error: 'no se pudo crear la cita en este momento',
      });
    }
  }

  private async registrar(
    ctx: TurnContext,
    argsCrudos: unknown,
    estado: ToolStatus,
    empezado: number,
    resto: { data?: CrearCitaOutput; error?: string },
  ): Promise<ToolResult<CrearCitaOutput>> {
    const latencyMs = Date.now() - empezado;
    await this.toolCallRepository.record({
      conversationId: ctx.conversationId,
      herramienta: this.name,
      argumentosEnmascarados: maskArgsForLog(argsCrudos),
      estado,
      errorDetalle: resto.error,
      latenciaMs: latencyMs,
    });
    return { status: estado, data: resto.data, error: resto.error, latencyMs };
  }
}
