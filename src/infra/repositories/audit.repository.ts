/**
 * audit.repository.ts
 *
 * Implementacion de `AuditRepository` (src/core/types/ports.ts) sobre la
 * tabla `audit_log` (db/migrations/001_init.sql) via @supabase/supabase-js.
 *
 * La inmutabilidad de `audit_log` (control C10: registro inalterable) NO la
 * garantiza este archivo: la garantiza el `REVOKE update, delete` de la
 * migracion 001, que aplica incluso con `SUPABASE_SERVICE_KEY` (ver el
 * comentario de cabecera de esa migracion). Este repositorio, en consecuencia,
 * nunca expone update ni delete: solo `log`, que inserta.
 *
 * `detalle` llega ya enmascarado desde quien llama (regla del contrato:
 * "nada de PII en logs, todo pasa por el enmascarador" antes de esta capa).
 * El nombre de columna `detalle_enmascarado` documenta esa expectativa; este
 * archivo no vuelve a enmascarar porque no tiene el masker inyectado (el
 * puerto no lo contempla).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditRepository } from '../../core/types/index.js';

export class SupabaseAuditRepository implements AuditRepository {
  constructor(private readonly client: SupabaseClient) {}

  async log(
    evento: string,
    detalle: Record<string, unknown>,
    clinicId?: string,
    conversationId?: string,
  ): Promise<void> {
    const { error } = await this.client.from('audit_log').insert({
      evento,
      detalle_enmascarado: detalle,
      clinic_id: clinicId ?? null,
      conversation_id: conversationId ?? null,
    });

    if (error) {
      throw new Error(`audit_log.log fallo (evento=${evento}): ${error.message}`);
    }
  }
}
