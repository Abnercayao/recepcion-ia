/**
 * message.repository.ts
 *
 * Implementacion de `MessageRepository` (src/core/types/ports.ts) sobre la
 * tabla `messages` (db/migrations/001_init.sql) via @supabase/supabase-js.
 * `messages` es append-only (sin updated_at, ver comentario de la migracion):
 * este archivo nunca expone un update.
 *
 * AISLAMIENTO entre clinicas en `listByConversation` (vacio detectado, ver
 * informe final): el puerto (ports.ts) NO recibe clinicId en este metodo, asi
 * que no hay un valor "esperado" contra el que comparar via join. La garantia
 * que SI se puede hacer cumplir desde aqui es estructural, igual que
 * documenta `knowledge.repository.ts` para `matchKnowledge`: el filtro es
 * SIEMPRE por `conversation_id` (nunca un select sin acotar), y
 * `conversation_id` -> `conversations.clinic_id` es una relacion 1:1 (FK), asi
 * que ninguna fila devuelta puede pertenecer a una conversacion -y por tanto
 * una clinica- distinta de la solicitada. La responsabilidad de que
 * `conversationId` sea el correcto para la clinica en curso recae en quien
 * arma el `TurnContext` (fuera de esta rama), que obtiene ese id siempre a
 * traves de `ConversationRepository`, ese si acotado por `clinic_id`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Channel, MessageRepository, MessageRol, StoredMessage } from '../../core/types/index.js';

/** Fila cruda de `messages` tal como la devuelve supabase-js. */
interface MessageRow {
  id: string;
  conversation_id: string;
  rol: MessageRol;
  contenido: string;
  canal: Channel;
  session_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latencia_ms: number | null;
  creado_en: string;
}

function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    rol: row.rol,
    contenido: row.contenido,
    canal: row.canal,
    sessionId: row.session_id ?? undefined,
    tokensIn: row.tokens_in ?? undefined,
    tokensOut: row.tokens_out ?? undefined,
    latenciaMs: row.latencia_ms ?? undefined,
    creadoEn: new Date(row.creado_en),
  };
}

export class SupabaseMessageRepository implements MessageRepository {
  constructor(private readonly client: SupabaseClient) {}

  async append(msg: {
    conversationId: string;
    rol: MessageRol;
    contenido: string;
    canal: Channel;
    sessionId?: string;
    tokensIn?: number;
    tokensOut?: number;
    latenciaMs?: number;
  }): Promise<StoredMessage> {
    const { data, error } = await this.client
      .from('messages')
      .insert({
        conversation_id: msg.conversationId,
        rol: msg.rol,
        contenido: msg.contenido,
        canal: msg.canal,
        session_id: msg.sessionId ?? null,
        tokens_in: msg.tokensIn ?? null,
        tokens_out: msg.tokensOut ?? null,
        latencia_ms: msg.latenciaMs ?? null,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`messages.append fallo (conversation=${msg.conversationId}): ${error.message}`);
    }

    return mapMessageRow(data as MessageRow);
  }

  async listByConversation(conversationId: string, limit?: number): Promise<StoredMessage[]> {
    // Se pide siempre en orden DESCENDENTE de creado_en (mas reciente primero)
    // y se revierte al final. Es lo que hace que, cuando `limit` acota una
    // ventana de contexto, el resultado sean los N mensajes MAS RECIENTES (los
    // relevantes para el turno en curso) y no los N mas antiguos; sin `limit`
    // el resultado final es igualmente el historial completo en orden
    // cronologico de lectura (ascendente), que es lo que espera TurnContext.
    let query = this.client
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('creado_en', { ascending: false });

    if (limit !== undefined) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`messages.listByConversation fallo (conversation=${conversationId}): ${error.message}`);
    }

    return ((data as MessageRow[] | null) ?? []).map(mapMessageRow).reverse();
  }
}
