/**
 * tool-call.repository.ts
 *
 * Implementacion de `ToolCallRepository` (src/core/types/ports.ts) sobre la
 * tabla `tool_calls` (db/migrations/001_init.sql) via @supabase/supabase-js.
 *
 * `countByTool` hace cumplir `maxCallsPerConversation` (core/types/tool.ts):
 * usa `count: 'exact', head: true` para pedirle a Postgres solo el numero de
 * filas, sin traer datos que de todas formas se descartarian.
 *
 * Nota sobre nombres: `argumentosEnmascarados` (puerto, ver ToolCallRecord en
 * core/types/tool.ts) ya llega enmascarado desde quien registra la llamada
 * (la capa de herramientas, fuera de esta rama); este repositorio solo
 * persiste, no aplica el enmascarador.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolCallRecord, ToolCallRepository } from '../../core/types/index.js';

export class SupabaseToolCallRepository implements ToolCallRepository {
  constructor(private readonly client: SupabaseClient) {}

  async record(call: ToolCallRecord): Promise<void> {
    const { error } = await this.client.from('tool_calls').insert({
      conversation_id: call.conversationId,
      message_id: call.messageId ?? null,
      herramienta: call.herramienta,
      argumentos_enmascarados: call.argumentosEnmascarados,
      estado: call.estado,
      error_detalle: call.errorDetalle ?? null,
      latencia_ms: call.latenciaMs,
    });

    if (error) {
      throw new Error(
        `tool_calls.record fallo (conversation=${call.conversationId}, herramienta=${call.herramienta}): ${error.message}`,
      );
    }
  }

  async countByTool(conversationId: string, herramienta: string): Promise<number> {
    const { count, error } = await this.client
      .from('tool_calls')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('herramienta', herramienta);

    if (error) {
      throw new Error(
        `tool_calls.countByTool fallo (conversation=${conversationId}, herramienta=${herramienta}): ${error.message}`,
      );
    }

    return count ?? 0;
  }
}
