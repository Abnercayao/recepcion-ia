/**
 * clinic.repository.ts
 *
 * Implementacion de `ClinicRepository` (src/core/types/ports.ts) sobre la
 * tabla `clinics` (db/migrations/001_init.sql) via @supabase/supabase-js.
 *
 * Esta tabla no tiene columna `clinic_id` -es la tabla clinica misma-, asi
 * que el filtro relevante aqui es `id` (la propia PK). No hay riesgo de fuga
 * entre clinicas porque `findById` siempre filtra por un id concreto y nunca
 * hace un `select` sin filtro que pudiera devolver mas de una fila.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Clinic, ClinicRepository } from '../../core/types/index.js';

/** Fila cruda de `clinics` tal como la devuelve supabase-js (snake_case, sin tipar por la libreria). */
interface ClinicRow {
  id: string;
  nombre: string;
  timezone: string;
  config: Record<string, unknown> | null;
  retencion_transcripcion_dias: number;
  retencion_audio_dias: number;
  transfer_whitelist: string[] | null;
}

function mapClinicRow(row: ClinicRow): Clinic {
  return {
    id: row.id,
    nombre: row.nombre,
    timezone: row.timezone,
    config: row.config ?? {},
    retencionTranscripcionDias: row.retencion_transcripcion_dias,
    retencionAudioDias: row.retencion_audio_dias,
    transferWhitelist: row.transfer_whitelist ?? [],
  };
}

export class SupabaseClinicRepository implements ClinicRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(clinicId: string): Promise<Clinic | null> {
    const { data, error } = await this.client.from('clinics').select('*').eq('id', clinicId).maybeSingle();

    // null solo significa "no existe" (maybeSingle no marca error cuando no
    // hay filas). Un fallo real de infraestructura SI trae `error` y se lanza
    // con contexto: nunca se devuelve null en ese caso.
    if (error) {
      throw new Error(`clinics.findById fallo (id=${clinicId}): ${error.message}`);
    }
    if (!data) return null;

    return mapClinicRow(data as ClinicRow);
  }
}
