/**
 * patient.repository.ts
 *
 * Implementacion de `PatientRepository` (src/core/types/ports.ts) sobre la
 * tabla `patients` (db/migrations/001_init.sql) via @supabase/supabase-js.
 *
 * `upsert` usa el UNIQUE (clinic_id, telefono_e164) de la migracion con
 * `onConflict`, en una unica sentencia atomica: un "select, luego insert si
 * no existe" tiene condicion de carrera entre dos mensajes casi simultaneos
 * del mismo paciente (p. ej. voz y WhatsApp llegando a la vez).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Patient, PatientRepository } from '../../core/types/index.js';

/** Fila cruda de `patients` tal como la devuelve supabase-js. */
interface PatientRow {
  id: string;
  clinic_id: string;
  telefono_e164: string;
  nombre: string | null;
  consentimiento_at: string | null;
  consentimiento_canal: string | null;
}

function mapPatientRow(row: PatientRow): Patient {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    telefonoE164: row.telefono_e164,
    nombre: row.nombre ?? undefined,
    consentimientoAt: row.consentimiento_at ? new Date(row.consentimiento_at) : undefined,
    consentimientoCanal: row.consentimiento_canal ?? undefined,
  };
}

export class SupabasePatientRepository implements PatientRepository {
  constructor(private readonly client: SupabaseClient) {}

  async upsert(clinicId: string, telefonoE164: string, nombre?: string): Promise<Patient> {
    const payload: Record<string, unknown> = {
      clinic_id: clinicId,
      telefono_e164: telefonoE164,
    };
    // "nombre" solo entra en el payload si vino informado: un upsert por
    // ON CONFLICT DO UPDATE solo actualiza las columnas presentes en el
    // objeto, asi que omitirla preserva el nombre ya guardado en vez de
    // borrarlo con null cada vez que llega un mensaje sin nombre (WhatsApp
    // normalmente solo lo manda en el primer contacto).
    if (nombre !== undefined) {
      payload.nombre = nombre;
    }

    const { data, error } = await this.client
      .from('patients')
      .upsert(payload, { onConflict: 'clinic_id,telefono_e164' })
      .select('*')
      .single();

    if (error) {
      throw new Error(`patients.upsert fallo (clinic=${clinicId}, telefono=${telefonoE164}): ${error.message}`);
    }

    return mapPatientRow(data as PatientRow);
  }
}
