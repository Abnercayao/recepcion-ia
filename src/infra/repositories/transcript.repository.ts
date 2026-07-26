/**
 * transcript.repository.ts
 *
 * Implementacion sobre Supabase de `TranscriptRepository`
 * (`src/channels/voice/voice.types.ts`) para la tabla `transcripts` de
 * `db/migrations/001_init.sql`.
 *
 * `transcripts` es APPEND-ONLY (no tiene `updated_at`, igual que `messages`):
 * este archivo no expone ningun update ni delete. Una transcripcion que se
 * puede reescribir no sirve como evidencia de nada.
 *
 * AISLAMIENTO: la tabla no tiene `clinic_id`; la pertenencia se deriva por FK
 * (`call_id` -> `calls.conversation_id` -> `conversations.clinic_id`). La
 * garantia que se hace cumplir aqui es estructural: `listByCall` SIEMPRE filtra
 * por `call_id` y no existe un `select` sin acotar, asi que ninguna fila
 * devuelta puede pertenecer a otra llamada.
 *
 * ---------------------------------------------------------------------------
 * VACIO DEL ESQUEMA DETECTADO (declarar en el informe)
 * ---------------------------------------------------------------------------
 * `transcripts` no tiene ninguna columna monotona (ni `creado_en`, ni un
 * `orden` entero): las unicas pistas temporales son `ts_inicio_ms` /
 * `ts_fin_ms`, que son NULLABLE. Consecuencia: el orden cronologico de la
 * transcripcion SOLO esta garantizado para las lineas que traen
 * `ts_inicio_ms` -las que consolida el webhook post-llamada del proveedor-. Las
 * que escribe el gateway turno a turno no lo traen (no medimos el offset de
 * audio) y quedan al final, en el orden en que Postgres las devuelva, que no
 * esta definido. `listByCall` ordena por `ts_inicio_ms` ascendente y lo
 * documenta en vez de fingir una garantia que el esquema no da.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Hablante,
  NuevaLineaDeTranscripcion,
  TranscriptLine,
  TranscriptRepository,
} from '../../channels/voice/voice.types.js';

interface TranscriptRow {
  id: string;
  call_id: string;
  hablante: Hablante;
  texto: string;
  ts_inicio_ms: number | null;
  ts_fin_ms: number | null;
  /** `numeric` de Postgres: supabase-js lo entrega como number o como string. */
  confianza: number | string | null;
}

function mapTranscriptRow(row: TranscriptRow): TranscriptLine {
  const linea: TranscriptLine = {
    id: row.id,
    callId: row.call_id,
    hablante: row.hablante,
    texto: row.texto,
  };
  if (row.ts_inicio_ms !== null) linea.tsInicioMs = row.ts_inicio_ms;
  if (row.ts_fin_ms !== null) linea.tsFinMs = row.ts_fin_ms;
  if (row.confianza !== null && row.confianza !== undefined) {
    // `numeric` puede llegar como string para no perder precision. Se convierte
    // explicitamente: una confianza que viaja como texto rompe cualquier umbral.
    const valor = typeof row.confianza === 'string' ? Number(row.confianza) : row.confianza;
    if (Number.isFinite(valor)) linea.confianza = valor;
  }
  return linea;
}

function aFila(linea: NuevaLineaDeTranscripcion): Record<string, unknown> {
  return {
    call_id: linea.callId,
    hablante: linea.hablante,
    texto: linea.texto,
    ts_inicio_ms: linea.tsInicioMs ?? null,
    ts_fin_ms: linea.tsFinMs ?? null,
    confianza: linea.confianza ?? null,
  };
}

export class SupabaseTranscriptRepository implements TranscriptRepository {
  constructor(private readonly client: SupabaseClient) {}

  async append(linea: NuevaLineaDeTranscripcion): Promise<TranscriptLine> {
    const { data, error } = await this.client
      .from('transcripts')
      .insert(aFila(linea))
      .select('*')
      .single();

    if (error) {
      throw new Error(`transcripts.append fallo (call=${linea.callId}): ${error.message}`);
    }
    return mapTranscriptRow(data as TranscriptRow);
  }

  /**
   * Insercion en lote. Un solo viaje a la base por turno en vez de dos: en el
   * canal de voz cada ida y vuelta cuenta, aunque esta ocurra despues de cerrar
   * el stream.
   */
  async appendMany(lineas: readonly NuevaLineaDeTranscripcion[]): Promise<TranscriptLine[]> {
    if (lineas.length === 0) return [];

    const { data, error } = await this.client
      .from('transcripts')
      .insert(lineas.map(aFila))
      .select('*');

    if (error) {
      const callIds = [...new Set(lineas.map((l) => l.callId))].join(',');
      throw new Error(`transcripts.appendMany fallo (calls=${callIds}): ${error.message}`);
    }
    return ((data as TranscriptRow[] | null) ?? []).map(mapTranscriptRow);
  }

  /** Ver el VACIO DEL ESQUEMA de la cabecera sobre las garantias de orden. */
  async listByCall(callId: string): Promise<TranscriptLine[]> {
    const { data, error } = await this.client
      .from('transcripts')
      .select('*')
      .eq('call_id', callId)
      .order('ts_inicio_ms', { ascending: true });

    if (error) {
      throw new Error(`transcripts.listByCall fallo (call=${callId}): ${error.message}`);
    }
    return ((data as TranscriptRow[] | null) ?? []).map(mapTranscriptRow);
  }
}
