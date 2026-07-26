/**
 * conversation.repository.ts
 *
 * Implementacion de `ConversationRepository` (src/core/types/ports.ts) sobre
 * la tabla `conversations` (db/migrations/001_init.sql) via
 * @supabase/supabase-js.
 *
 * `findActiveWithin` es la consulta que sostiene la continuidad multicanal
 * (seccion 10 del brief): busca por (clinic_id, patient_id) con
 * ultima_actividad >= since y estado = 'activa', ordena por ultima_actividad
 * descendente y toma la primera. Usa el indice
 * `(clinic_id, patient_id, ultima_actividad desc)` de la migracion.
 *
 * `touch` y `markEscalated` no reciben clinicId en la firma del puerto: no
 * hay un valor "esperado" contra el que comparar. La escritura queda acotada
 * por el id de conversacion (PK), que es el unico dato que estos metodos
 * tienen para identificar la fila; no se puede (ni corresponde) inventar un
 * filtro adicional por clinica que el puerto no ofrece.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Channel, Conversation, ConversationEstado, ConversationRepository } from '../../core/types/index.js';

/** Fila cruda de `conversations` tal como la devuelve supabase-js. */
interface ConversationRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  estado: ConversationEstado;
  canal_origen: Channel;
  ultimo_canal: Channel;
  iniciada_en: string;
  ultima_actividad: string;
  escalada_en: string | null;
  escalada_motivo: string | null;
}

function mapConversationRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    patientId: row.patient_id,
    estado: row.estado,
    canalOrigen: row.canal_origen,
    ultimoCanal: row.ultimo_canal,
    iniciadaEn: new Date(row.iniciada_en),
    ultimaActividad: new Date(row.ultima_actividad),
    escaladaEn: row.escalada_en ? new Date(row.escalada_en) : undefined,
    escaladaMotivo: row.escalada_motivo ?? undefined,
  };
}

export class SupabaseConversationRepository implements ConversationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findActiveWithin(clinicId: string, patientId: string, since: Date): Promise<Conversation | null> {
    const { data, error } = await this.client
      .from('conversations')
      .select('*')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .eq('estado', 'activa')
      .gte('ultima_actividad', since.toISOString())
      .order('ultima_actividad', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(
        `conversations.findActiveWithin fallo (clinic=${clinicId}, patient=${patientId}): ${error.message}`,
      );
    }
    if (!data) return null;

    return mapConversationRow(data as ConversationRow);
  }

  async create(clinicId: string, patientId: string, canal: Channel): Promise<Conversation> {
    const { data, error } = await this.client
      .from('conversations')
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        canal_origen: canal,
        ultimo_canal: canal,
        // estado ('activa'), iniciada_en y ultima_actividad quedan en su
        // default de la migracion: no hay razon de negocio para fijarlos
        // desde aqui, y depender del default evita divergencias si cambia.
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`conversations.create fallo (clinic=${clinicId}, patient=${patientId}): ${error.message}`);
    }

    return mapConversationRow(data as ConversationRow);
  }

  async touch(conversationId: string, ultimoCanal: Channel): Promise<void> {
    const { error } = await this.client
      .from('conversations')
      .update({
        ultimo_canal: ultimoCanal,
        ultima_actividad: new Date().toISOString(),
      })
      .eq('id', conversationId);

    if (error) {
      throw new Error(`conversations.touch fallo (id=${conversationId}): ${error.message}`);
    }
  }

  async markEscalated(conversationId: string, motivo: string): Promise<void> {
    const { error } = await this.client
      .from('conversations')
      .update({
        estado: 'escalada',
        escalada_en: new Date().toISOString(),
        escalada_motivo: motivo,
      })
      .eq('id', conversationId);

    if (error) {
      throw new Error(`conversations.markEscalated fallo (id=${conversationId}): ${error.message}`);
    }
  }
}
