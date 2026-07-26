import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { CalendarEvent, CalendarPort, Logger, ToolCallRepository } from '../types/ports.js';
import type { Clinic, TurnContext } from '../types/conversation.js';
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

const horarioClinicaSchema = z
  .object({
    horaApertura: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    horaCierre: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** 0=domingo .. 6=sabado (convencion de Intl.DateTimeFormat/Date#getDay). */
    diasLaborables: z.array(z.number().int().min(0).max(6)).min(1),
  })
  .partial();

/**
 * Horario por defecto: lunes(1) a sabado(6), 08:00-20:00.
 *
 * El tipo `Clinic` (contrato compartido, no lo puedo tocar) no fija la forma
 * del horario de atencion: `config` es `Record<string, unknown>`. Se lee
 * `clinic.config.horario` de forma defensiva con Zod y, si falta o es
 * invalido, se usa este valor por defecto en lugar de fallar o de asumir que
 * "no hay horario" (lo que dejaria crear citas a cualquier hora). Se deja
 * constancia de este vacio de la especificacion en el informe final.
 */
const HORARIO_POR_DEFECTO = {
  horaApertura: '08:00',
  horaCierre: '20:00',
  diasLaborables: [1, 2, 3, 4, 5, 6],
};

function resolverHorario(clinic: Clinic, logger: Logger) {
  const crudo = (clinic.config as Record<string, unknown> | undefined)?.['horario'];
  const parsed = horarioClinicaSchema.safeParse(crudo);
  if (!parsed.success) {
    logger.warn(
      { clinicId: clinic.id },
      'horario de clinica ausente o invalido en clinic.config; se usa horario por defecto',
    );
    return HORARIO_POR_DEFECTO;
  }
  return { ...HORARIO_POR_DEFECTO, ...parsed.data };
}

const DIA_SEMANA_A_NUMERO: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Traduce el instante a hora local de la clinica con `Intl` (sin dependencias nuevas) y valida horario. */
function dentroDeHorario(inicio: Date, clinic: Clinic, logger: Logger): boolean {
  const horario = resolverHorario(clinic, logger);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: clinic.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(inicio);

  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  const dia = DIA_SEMANA_A_NUMERO[partes.find((p) => p.type === 'weekday')?.value ?? ''] ?? -1;

  const minutosDelDia = hora * 60 + minuto;
  const [horaAp, minAp] = horario.horaApertura.split(':').map(Number);
  const [horaCi, minCi] = horario.horaCierre.split(':').map(Number);
  const minutosApertura = horaAp * 60 + minAp;
  const minutosCierre = horaCi * 60 + minCi;

  return horario.diasLaborables.includes(dia) && minutosDelDia >= minutosApertura && minutosDelDia < minutosCierre;
}

export const crearCitaInputSchema = z.object({
  inicio: z.iso.datetime({ offset: true }),
  duracionMin: z.number().int().min(DURACION_MIN_MINUTOS).max(DURACION_MAX_MINUTOS).default(30),
  motivo: z.string().min(1).max(200).optional(),
  profesional: z.string().min(1).max(120).optional(),
  /**
   * Debe llegar exactamente `true`. Si el campo viene `false`, ausente, o con
   * cualquier otro valor, `z.literal(true)` hace que `safeParse` falle antes
   * de que el resto del codigo se ejecute: el rechazo por falta de
   * confirmacion ocurre en la capa de validacion, no en un `if` que se pueda
   * saltar.
   */
  confirmadoPorPaciente: z.literal(true),
});
export type CrearCitaInput = z.infer<typeof crearCitaInputSchema>;

export interface CrearCitaOutput {
  evento: CalendarEvent;
}

export class CrearCitaTool implements BusinessTool<CrearCitaInput, CrearCitaOutput> {
  readonly name = 'crear_cita' as const;
  readonly description =
    'Crea una cita en la agenda de la clinica. SOLO se puede llamar despues de que el paciente confirmo ' +
    'explicitamente fecha y hora (confirmadoPorPaciente=true); si el paciente todavia no confirmo, no la uses. ' +
    'Rechaza fechas pasadas, horarios fuera de atencion y horarios que ya no esten libres.';
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
      const faltaConfirmacion = parsed.error.issues.some((i) => i.path[0] === 'confirmadoPorPaciente');
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, {
        error: faltaConfirmacion
          ? 'no se puede crear la cita sin confirmacion explicita del paciente (confirmadoPorPaciente debe ser true)'
          : `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
    }

    const clinicId = ctx.clinic.id; // jamas de los argumentos del modelo
    const { duracionMin, motivo, profesional } = parsed.data;
    const inicioDate = new Date(parsed.data.inicio);
    const finDate = new Date(inicioDate.getTime() + duracionMin * 60_000);

    if (inicioDate.getTime() <= ctx.now.getTime()) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: 'no se puede agendar una cita en el pasado',
      });
    }
    if (!dentroDeHorario(inicioDate, ctx.clinic, this.logger)) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: 'el horario solicitado esta fuera del horario de atencion de la clinica',
      });
    }

    // Segunda verificacion de colision: se hace AQUI, inmediatamente antes de
    // createEvent, no antes. Cualquier confirmacion del paciente o consulta
    // previa a consultar_agenda puede haber quedado obsoleta (otra
    // conversacion pudo tomar el mismo horario mientras tanto); el unico
    // chequeo que cuenta es el que ocurre justo antes de escribir.
    let libre: boolean;
    try {
      libre = await this.calendarPort.isSlotFree(clinicId, inicioDate, finDate);
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
      const evento = await this.calendarPort.createEvent(
        clinicId,
        { start: inicioDate, end: finDate, titulo: motivo ?? 'Cita', profesional },
        ctx.patient.telefonoE164,
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
