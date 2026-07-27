import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { CalendarPort, CalendarSlot, Logger, ToolCallRepository } from '../types/ports.js';
import type { TurnContext } from '../types/conversation.js';
import { maskArgsForLog } from './tool.registry.js';
import { citaDentroDeHorario, resolverFranjas } from './horario-clinica.js';

/**
 * Rango maximo de consulta: 30 dias.
 *
 * Justificacion: esta es una recepcion que agenda a corto plazo (los propios
 * recordatorios del sistema operan en ventanas de 72/24/3 horas, seccion 11
 * de la especificacion). Un rango mayor no le sirve al paciente para elegir
 * un horario cercano y multiplica el costo de cada consulta a Google
 * Calendar; tambien acota el dano de un rango alucinado o forzado por el
 * modelo (o por un intento de abuso) a, como mucho, un mes de datos de
 * disponibilidad - nunca de citas de otros pacientes, que esta herramienta
 * no expone en ningun caso.
 */
export const RANGO_MAXIMO_CONSULTA_DIAS = 30;

const RANGO_MAXIMO_CONSULTA_MS = RANGO_MAXIMO_CONSULTA_DIAS * 24 * 60 * 60 * 1000;

export const consultarAgendaInputSchema = z.object({
  desde: z.iso.datetime({ offset: true }),
  hasta: z.iso.datetime({ offset: true }),
  duracionMin: z.number().int().min(15).max(240).default(30),
  profesional: z.string().min(1).max(120).optional(),
});
export type ConsultarAgendaInput = z.infer<typeof consultarAgendaInputSchema>;

export interface ConsultarAgendaOutput {
  slots: CalendarSlot[];
}

/**
 * Consulta disponibilidad de agenda.
 *
 * El `clinicId` SIEMPRE sale de `ctx.clinic.id`; el esquema de entrada ni
 * siquiera tiene un campo para que el modelo proponga uno. Y como el puerto
 * solo devuelve huecos LIBRES (`CalendarPort.findAvailableSlots`), no existe
 * manera de que esta herramienta filtre datos de un paciente distinto: los
 * huecos nunca llevan nombre de nadie porque el tipo `CalendarSlot` no tiene
 * ese campo.
 */
export class ConsultarAgendaTool implements BusinessTool<ConsultarAgendaInput, ConsultarAgendaOutput> {
  readonly name = 'consultar_agenda' as const;
  readonly description =
    'Consulta los horarios libres de la agenda de la clinica dentro de un rango de fechas (maximo ' +
    `${RANGO_MAXIMO_CONSULTA_DIAS} dias). Usarla ANTES de crear_cita, cuando el paciente quiere saber que ` +
    'horarios hay disponibles. Nunca devuelve citas ya reservadas ni datos de otros pacientes, solo huecos libres.';
  readonly input = consultarAgendaInputSchema;
  /**
   * 6 llamadas por conversacion: suficiente para explorar 2-3 dias distintos
   * o cambiar de profesional un par de veces dentro de la misma charla, sin
   * dejar que un bucle del modelo golpee el calendario sin limite.
   */
  readonly maxCallsPerConversation = 6;

  constructor(
    private readonly calendarPort: CalendarPort,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {}

  async execute(args: ConsultarAgendaInput, ctx: TurnContext): Promise<ToolResult<ConsultarAgendaOutput>> {
    const empezado = Date.now();
    const parsed = this.input.safeParse(args);
    if (!parsed.success) {
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, {
        error: `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
    }

    const clinicId = ctx.clinic.id; // jamas de los argumentos del modelo
    const { duracionMin } = parsed.data;
    let desdeDate = new Date(parsed.data.desde);
    const hastaDate = new Date(parsed.data.hasta);

    if (hastaDate.getTime() <= ctx.now.getTime()) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: 'el rango solicitado esta completamente en el pasado',
      });
    }
    if (desdeDate.getTime() < ctx.now.getTime()) {
      // ajuste silencioso: no rechazamos solo por un margen de latencia entre
      // que el modelo redacto "hoy" y el momento en que esto se ejecuta.
      desdeDate = ctx.now;
    }
    if (desdeDate.getTime() >= hastaDate.getTime()) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: '"desde" debe ser anterior a "hasta"',
      });
    }
    if (hastaDate.getTime() - desdeDate.getTime() > RANGO_MAXIMO_CONSULTA_MS) {
      return this.registrar(ctx, parsed.data, 'rechazada_validacion', empezado, {
        error: `el rango maximo de consulta es de ${RANGO_MAXIMO_CONSULTA_DIAS} dias`,
      });
    }

    try {
      const libres = await this.calendarPort.findAvailableSlots(clinicId, desdeDate, hastaDate, duracionMin);

      // `freebusy` responde que las 23:57 estan libres, y lo estan: nadie las
      // ha reservado. Que la clinica no atienda a esa hora es una regla suya,
      // y filtrarla es de esta herramienta. Sin esto el agente ofrece horarios
      // que `crear_cita` despues rechaza — ofrecer y luego negar es peor que
      // no ofrecer.
      const franjas = resolverFranjas(ctx.clinic, this.logger);
      const slots = libres.filter((s) => citaDentroDeHorario(s.start, duracionMin, ctx.clinic, undefined, franjas));

      if (slots.length < libres.length) {
        this.logger.debug(
          { clinicId, ofrecidos: slots.length, descartados: libres.length - slots.length },
          'huecos descartados por caer fuera del horario de atencion de la clinica',
        );
      }
      return this.registrar(ctx, parsed.data, 'ok', empezado, { data: { slots } });
    } catch (err) {
      this.logger.error({ err: String(err), clinicId }, 'fallo consultando disponibilidad de agenda');
      return this.registrar(ctx, parsed.data, 'error', empezado, {
        error: 'no se pudo consultar la agenda en este momento',
      });
    }
  }

  private async registrar(
    ctx: TurnContext,
    argsCrudos: unknown,
    estado: ToolStatus,
    empezado: number,
    resto: { data?: ConsultarAgendaOutput; error?: string },
  ): Promise<ToolResult<ConsultarAgendaOutput>> {
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
