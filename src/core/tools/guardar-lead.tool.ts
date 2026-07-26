import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { AuditRepository, Logger, ToolCallRepository } from '../types/ports.js';
import type { TurnContext } from '../types/conversation.js';
import { enmascararTexto, maskArgsForLog } from './tool.registry.js';

/**
 * `ports.ts` (contrato compartido, fuera de mi alcance) no define un
 * `LeadRepository`. Guardar un lead es, en esencia, registrar un evento
 * auditable de interes comercial, asi que esta herramienta usa
 * `AuditRepository.log` como destino de persistencia en lugar de inventar un
 * puerto nuevo. Si otra rama define mas adelante un `LeadRepository` dedicado,
 * este archivo es el unico punto de cambio. Se deja constancia de este vacio
 * en el informe final.
 */
export const interesNivelSchema = z.enum(['alto', 'medio', 'bajo']);
export type InteresNivel = z.infer<typeof interesNivelSchema>;

export const guardarLeadInputSchema = z.object({
  interesNivel: interesNivelSchema,
  /** Resumen breve NO clinico. Se enmascara antes de escribirse en cualquier registro. */
  motivoResumen: z.string().min(1).max(300),
  contactoPreferido: z.enum(['whatsapp', 'voz']).optional(),
});
export type GuardarLeadInput = z.infer<typeof guardarLeadInputSchema>;

export interface GuardarLeadOutput {
  guardado: true;
}

/**
 * Registra el interes comercial del paciente para seguimiento posterior.
 *
 * `interesNivel` es SIEMPRE una categoria cerrada (`alto`/`medio`/`bajo`):
 * estructuralmente no hay forma de que el "campo de scoring" termine
 * cargando contenido clinico literal, porque el esquema no admite texto
 * libre en ese campo. `motivoResumen` si es texto libre y puede llegar con
 * PII (telefono, DNI, correo) si el paciente lo menciono: se enmascara antes
 * de persistir, nunca se guarda en claro.
 */
export class GuardarLeadTool implements BusinessTool<GuardarLeadInput, GuardarLeadOutput> {
  readonly name = 'guardar_lead' as const;
  readonly description =
    'Registra el nivel de interes comercial del paciente (alto/medio/bajo) para seguimiento de recepcion. ' +
    'interesNivel es SIEMPRE una categoria, nunca contenido clinico. motivoResumen debe ser un resumen breve y NO ' +
    'clinico (ej. "pregunta por disponibilidad de citas de ortodoncia"), nunca sintomas, diagnosticos ni tratamientos.';
  readonly input = guardarLeadInputSchema;
  /**
   * 3 llamadas por conversacion: el interes del paciente puede reevaluarse
   * una o dos veces a medida que la charla avanza (p. ej. de "medio" a
   * "alto" tras resolver una duda), pero mas de tres actualizaciones en una
   * sola conversacion ya no es scoring, es ruido.
   */
  readonly maxCallsPerConversation = 3;

  constructor(
    private readonly auditRepository: AuditRepository,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {}

  async execute(args: GuardarLeadInput, ctx: TurnContext): Promise<ToolResult<GuardarLeadOutput>> {
    const empezado = Date.now();
    const parsed = this.input.safeParse(args);
    if (!parsed.success) {
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, {
        error: `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
    }

    // enmascarado ANTES de escribir a auditoria: nunca sale un telefono, DNI
    // o correo en claro, aunque el paciente lo haya mencionado en el turno.
    const motivoEnmascarado = enmascararTexto(parsed.data.motivoResumen);
    // si el modelo no propuso contactoPreferido, se infiere del canal actual;
    // ctx.channel usa 'voice' (ingles, tipo compartido) y este campo usa 'voz'
    // (espanol, propio de esta herramienta) - se traduce explicitamente para
    // no filtrar el valor en ingles a un campo que el resto del codigo espera en espanol.
    const contactoPorDefecto = ctx.channel === 'voice' ? 'voz' : 'whatsapp';

    try {
      await this.auditRepository.log(
        'lead_guardado',
        {
          interesNivel: parsed.data.interesNivel,
          motivoResumen: motivoEnmascarado,
          contactoPreferido: parsed.data.contactoPreferido ?? contactoPorDefecto,
        },
        ctx.clinic.id,
        ctx.conversationId,
      );
    } catch (err) {
      this.logger.error({ err: String(err), clinicId: ctx.clinic.id }, 'fallo guardando el lead en auditoria');
      return this.registrar(ctx, parsed.data, 'error', empezado, {
        error: 'no se pudo guardar el registro de interes en este momento',
      });
    }

    return this.registrar(ctx, parsed.data, 'ok', empezado, { data: { guardado: true } });
  }

  private async registrar(
    ctx: TurnContext,
    argsCrudos: unknown,
    estado: ToolStatus,
    empezado: number,
    resto: { data?: GuardarLeadOutput; error?: string },
  ): Promise<ToolResult<GuardarLeadOutput>> {
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
