import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { CalendarPort, CalendarSlot, Logger, ToolCallRepository } from '../types/ports.js';
import type { TurnContext } from '../types/conversation.js';
import { cierresProximos, generarCandidatos, resolverAgenda } from '../agenda/horario.js';
import { maskArgsForLog } from './tool.registry.js';

/**
 * Tope de huecos por consulta.
 *
 * Cada candidato es una comprobacion contra el calendario. Catorce cubren de
 * sobra un dia entero de la clinica (09:00-13:00 y 14:00-19:00 en tramos de 40
 * minutos son 13), y acotan el coste si el modelo pide un rango de 30 dias.
 * Al paciente no se le leen catorce horarios: el prompt manda ofrecer dos.
 */
export const MAXIMO_HUECOS_POR_CONSULTA = 14;

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
  /**
   * Sede sobre la que se pregunta.
   *
   * Existe porque el modelo necesitaba ponerla en algun sitio: sin este campo
   * la colaba en `profesional` --visto en la traza: `profesional: "Comas"`--,
   * que es un dato distinto y acaba escrito en la cita.
   *
   * En v1 NO filtra la disponibilidad: `CalendarPort` no lleva sede y todas
   * las sedes comparten un unico calendario (ver `_limitacion_v1` en la
   * semilla). Se acepta y se registra para que la traza diga sobre que sede
   * creia el modelo estar preguntando, que es justo lo que hace falta el dia
   * que se separen los calendarios.
   */
  sede: z.string().min(1).max(80).optional(),
});
export type ConsultarAgendaInput = z.infer<typeof consultarAgendaInputSchema>;

export interface ConsultarAgendaOutput {
  slots: CalendarSlot[];
  /**
   * Por que no hay huecos, cuando no los hay.
   *
   * «Cerrado por feriado» y «abierto pero lleno» son cosas distintas y el
   * paciente merece saber cual. Sin esto, el modelo recibia una lista vacia y
   * se inventaba el motivo --normalmente el equivocado--.
   */
  motivo?: string;
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
    'horarios hay disponibles. Solo devuelve horarios en los que la clinica ABRE de verdad: respeta el ' +
    'horario semanal, la pausa de mediodia y los feriados. Si devuelve la lista vacia, lee el campo ' +
    '"motivo": no es lo mismo un feriado que un dia lleno. Pon la sede en el campo "sede", nunca en ' +
    '"profesional". Nunca devuelve citas ya reservadas ni datos de otros pacientes, solo huecos libres.';
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

    /**
     * LOS HUECOS SE GENERAN AQUI, no en el adaptador de calendario.
     *
     * Antes esto delegaba en `CalendarPort.findAvailableSlots`, y de ahi salian
     * los dos fallos que el paciente notaba:
     *
     *   · «no hay espacio» habiendolo. La rejilla de la implementacion de
     *     Google se anclaba en el `desde` que mandara el modelo --a menudo una
     *     hora arbitraria-- y avanzaba a pasos ciegos. Si la ventana pedida era
     *     mas corta que la duracion de la cita («¿tienen algo a las 10?»),
     *     devolvia CERO huecos y el agente afirmaba que el dia estaba lleno. Y
     *     en la web, el doble de agenda arranca con la lista de huecos vacia,
     *     asi que NUNCA hubo disponibilidad.
     *   · huecos imposibles: de madrugada, en la pausa de mediodia, en domingo
     *     o en feriado, porque el adaptador no sabe nada del horario.
     *
     * Ahora los candidatos nacen del horario REAL de la clinica --alineados al
     * comienzo de cada tramo y saltando feriados-- y de cada uno se pregunta al
     * calendario si sigue libre. `isSlotFree` es ademas la consulta que el
     * propio contrato define como fresca (control C7), asi que no hay riesgo de
     * ofrecer un hueco que otra conversacion acaba de tomar.
     *
     * Se preguntan EN PARALELO: en serie, catorce huecos serian catorce idas y
     * vueltas encadenadas sobre un turno que el paciente esta esperando.
     */
    const agenda = resolverAgenda(ctx.clinic, this.logger);
    const candidatos = generarCandidatos(
      desdeDate,
      hastaDate,
      duracionMin,
      agenda,
      MAXIMO_HUECOS_POR_CONSULTA,
    );

    if (candidatos.length === 0) {
      // NO es lo mismo que «todo ocupado», y decirlo mal es justo lo que hacia
      // que el agente negara disponibilidad de un dia entero libre.
      const feriados = cierresProximos(desdeDate, 14, agenda);
      const detalle = feriados.length > 0
        ? ` Dias cerrados proximos: ${feriados.map((f) => `${f.iso} (${f.motivo})`).join(', ')}.`
        : '';
      return this.registrar(ctx, parsed.data, 'ok', empezado, {
        data: { slots: [], motivo: `la clinica no atiende en el rango consultado.${detalle}` },
      });
    }

    try {
      // La disponibilidad se pregunta SOBRE LA SEDE. Cada sede tiene su
      // agenda: que Comas este lleno no dice nada de Miraflores.
      const sedePedida = parsed.data.sede;
      const libres = await Promise.all(
        candidatos.map(async (c) =>
          (await this.calendarPort.isSlotFree(clinicId, c.start, c.end, sedePedida)) ? c : undefined,
        ),
      );
      const slots = libres
        .filter((c): c is { start: Date; end: Date } => c !== undefined)
        .map((c) => ({ ...c, ...(sedePedida ? { sede: sedePedida } : {}) }));
      return this.registrar(ctx, parsed.data, 'ok', empezado, {
        data: {
          slots,
          ...(slots.length === 0
            ? { motivo: 'la clinica atiende ese dia, pero todos los horarios estan ocupados' }
            : {}),
        },
      });
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
