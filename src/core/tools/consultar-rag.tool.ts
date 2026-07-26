import { z } from 'zod';
import type { BusinessTool, ToolResult, ToolStatus } from '../types/tool.js';
import type { KnowledgeChunk, Logger, RagPort, ToolCallRepository } from '../types/ports.js';
import type { TurnContext } from '../types/conversation.js';
import { maskArgsForLog } from './tool.registry.js';

/**
 * Limite de fragmentos por consulta: 8.
 *
 * Es el numero de fragmentos que razonablemente entran en el contexto de una
 * respuesta de recepcion sin diluir la relevancia del mas pertinente; tambien
 * acota cuanto contenido de la base de conocimiento puede terminar citado en
 * un solo turno si el modelo pide un limite alto.
 */
export const LIMITE_MAXIMO_CHUNKS = 8;

export const consultarRagInputSchema = z.object({
  consulta: z.string().min(1).max(500),
  limite: z.number().int().min(1).max(LIMITE_MAXIMO_CHUNKS).default(5),
});
export type ConsultarRagInput = z.infer<typeof consultarRagInputSchema>;

export interface ConsultarRagOutput {
  chunks: KnowledgeChunk[];
}

/**
 * Consulta la base de conocimiento (RAG) de la clinica.
 *
 * El `clinicId` SIEMPRE sale de `ctx.clinic.id` - el esquema de entrada no
 * tiene campo para que el modelo proponga uno. `RagPort.retrieve` ya promete
 * devolver solo fragmentos aprobados, activos y de la clinica indicada
 * (control C9), pero esta herramienta no confia ciegamente en esa promesa:
 * vuelve a filtrar por `clinicId` sobre lo que el puerto devuelve, como
 * defensa en profundidad ante un bug de implementacion del puerto.
 */
export class ConsultarRagTool implements BusinessTool<ConsultarRagInput, ConsultarRagOutput> {
  readonly name = 'consultar_rag' as const;
  readonly description =
    'Busca informacion aprobada de la clinica (horarios, servicios, ubicacion, preguntas frecuentes) para ' +
    'responder con precision. Si no devuelve nada relevante, declarar que no se tiene esa informacion y ofrecer ' +
    'agendar una cita o escalar a recepcion; nunca completar la respuesta con conocimiento general del modelo.';
  readonly input = consultarRagInputSchema;
  /**
   * 10 llamadas por conversacion: es la herramienta de "responder preguntas",
   * la que mas se invoca en una charla tipica (una por cada duda distinta del
   * paciente). El limite sigue existiendo para contener un bucle, pero mas
   * holgado que el resto porque es de solo lectura y de bajo riesgo.
   */
  readonly maxCallsPerConversation = 10;

  constructor(
    private readonly ragPort: RagPort,
    private readonly toolCallRepository: ToolCallRepository,
    private readonly logger: Logger,
  ) {}

  async execute(args: ConsultarRagInput, ctx: TurnContext): Promise<ToolResult<ConsultarRagOutput>> {
    const empezado = Date.now();
    const parsed = this.input.safeParse(args);
    if (!parsed.success) {
      return this.registrar(ctx, args, 'rechazada_validacion', empezado, {
        error: `argumentos invalidos: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
    }

    const clinicId = ctx.clinic.id; // jamas de los argumentos del modelo

    try {
      const chunks = await this.ragPort.retrieve(clinicId, parsed.data.consulta, parsed.data.limite);
      const filtrados = chunks.filter((c) => c.clinicId === clinicId);
      if (filtrados.length !== chunks.length) {
        this.logger.error(
          { clinicId, recibidos: chunks.length, filtrados: filtrados.length },
          'RagPort devolvio fragmentos de otra clinica; se descartaron antes de responder',
        );
      }
      return this.registrar(ctx, parsed.data, 'ok', empezado, { data: { chunks: filtrados } });
    } catch (err) {
      this.logger.error({ err: String(err), clinicId }, 'fallo consultando la base de conocimiento');
      return this.registrar(ctx, parsed.data, 'error', empezado, {
        error: 'no se pudo consultar la base de conocimiento en este momento',
      });
    }
  }

  private async registrar(
    ctx: TurnContext,
    argsCrudos: unknown,
    estado: ToolStatus,
    empezado: number,
    resto: { data?: ConsultarRagOutput; error?: string },
  ): Promise<ToolResult<ConsultarRagOutput>> {
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
