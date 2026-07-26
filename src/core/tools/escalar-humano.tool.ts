import type { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { ConversationRepository, Logger, NotificationPort, ToolCallRepository } from '../types/ports.js';
import { escalationRequestSchema, type EscalationRequest } from '../types/message.js';
import type { TurnContext } from '../types/conversation.js';
import { maskArgsForLog } from './tool.registry.js';

export interface EscalarHumanoOutput {
  escalado: true;
  /** True solo si `transferNumber` estaba en la lista blanca de la clinica. */
  transferAutorizado: boolean;
  /** Peticion saneada: si el numero no era valido, viaja sin `transferNumber`. */
  request: EscalationRequest;
}

/**
 * Deriva la conversacion a una persona.
 *
 * No redefine `EscalationRequest` ni su schema: reutiliza `escalationRequestSchema`,
 * ya definido en `types/message.ts` (contrato compartido), como `input` de la
 * herramienta. La unica logica propia de esta herramienta es la que el tipo
 * no puede expresar por si solo: `transferNumber` NUNCA se usa si no esta en
 * `ctx.clinic.transferWhitelist`, y el aviso a recepcion (`NotificationPort`)
 * se dispara siempre, pase lo que pase con el numero - el modo de fallo de
 * este sistema es notificar de mas, nunca callar (control O5 / C7).
 */
export class EscalarHumanoTool implements BusinessTool<EscalationRequest, EscalarHumanoOutput> {
  readonly name = 'escalar_humano' as const;
  readonly description =
    'Deriva la conversacion a una persona de la clinica: usar ante urgencia medica, peticion explicita de hablar ' +
    'con un humano, un reclamo, o dos fallos de comprension seguidos. transferNumber es opcional y solo se honra ' +
    'si esta autorizado por la clinica; si no lo esta, igualmente se notifica a recepcion por otro canal.';
  readonly input: z.ZodType<EscalationRequest> = escalationRequestSchema;
  /**
   * 2 llamadas por conversacion: escalar es, por definicion, el final del
   * intento comercial/conversacional. Una conversacion que necesita escalar
   * mas de dos veces ya esta en un estado anomalo que ningun reintento
   * automatico deberia seguir alimentando.
   */
  readonly maxCallsPerConversation = 2;

  constructor(
    private readonly notificationPort: NotificationPort,
    private readonly conversationRepository: ConversationRepository,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {}

  async execute(args: EscalationRequest, ctx: TurnContext): Promise<ToolResult<EscalarHumanoOutput>> {
    const empezado = Date.now();
    const parsed = this.input.safeParse(args);
    if (!parsed.success) {
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, {
        error: `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
    }

    const solicitado = parsed.data;
    // el numero de transferencia SOLO se usa si esta en la lista blanca de
    // ESTA clinica (nunca la de otra, ni una lista que traiga el modelo).
    const enListaBlanca = solicitado.transferNumber
      ? ctx.clinic.transferWhitelist.includes(solicitado.transferNumber)
      : false;

    if (solicitado.transferNumber && !enListaBlanca) {
      this.logger.warn(
        { conversationId: ctx.conversationId, clinicId: ctx.clinic.id },
        'transferNumber propuesto no esta en la lista blanca de la clinica; se descarta y se usa notificacion de respaldo',
      );
    }

    const requestSaneado: EscalationRequest = {
      ...solicitado,
      transferNumber: enListaBlanca ? solicitado.transferNumber : undefined,
    };

    try {
      await this.conversationRepository.markEscalated(ctx.conversationId, requestSaneado.reason);
    } catch (err) {
      // no bloquea el aviso a recepcion: preferimos notificar aunque el
      // marcado de estado de la conversacion falle, a no notificar a nadie.
      this.logger.error({ err: String(err) }, 'fallo marcando la conversacion como escalada');
    }

    try {
      await this.notificationPort.notifyEscalation(ctx, requestSaneado);
    } catch (err) {
      // NotificationPort es el canal de respaldo final; si el respaldo mismo
      // falla no queda nada mas dentro de esta herramienta. Se registra como
      // fallo real (fatal) para seguimiento manual, nunca en silencio.
      this.logger.fatal(
        { err: String(err), clinicId: ctx.clinic.id, conversationId: ctx.conversationId },
        'fallo el canal de notificacion de escalamiento: no hay respaldo adicional dentro de esta herramienta',
      );
      return this.registrar(ctx, solicitado, 'error', empezado, {
        error: 'no se pudo notificar a recepcion; el fallo quedo registrado para seguimiento manual',
      });
    }

    return this.registrar(ctx, solicitado, 'ok', empezado, {
      data: { escalado: true, transferAutorizado: enListaBlanca, request: requestSaneado },
    });
  }

  private async registrar(
    ctx: TurnContext,
    argsCrudos: unknown,
    estado: ToolStatus,
    empezado: number,
    resto: { data?: EscalarHumanoOutput; error?: string },
  ): Promise<ToolResult<EscalarHumanoOutput>> {
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
