/**
 * call.repository.ts
 *
 * Implementacion sobre Supabase de `CallRepository`
 * (`src/channels/voice/voice.types.ts`) para las tablas `calls`,
 * `audio_events` y `latency_metrics` de `db/migrations/001_init.sql`.
 *
 * Mismo patron que el resto de `src/infra/repositories/`: mapeo EXPLICITO
 * snake_case <-> camelCase, `timestamptz` (string ISO) <-> `Date`, `null` de la
 * base <-> `undefined` del dominio, y todo error de infraestructura se lanza
 * con contexto de tabla y operacion (nunca se traga como `null`).
 *
 * POR QUE EL PUERTO NO ESTA EN `core/types/ports.ts`: ver el comentario de
 * cabecera de `src/channels/voice/voice.types.ts`. `ports.ts` es un contrato
 * congelado que no contempla la telefonia, y `calls`/`transcripts` son
 * conceptos exclusivos del canal de voz. La interfaz vive del lado del
 * consumidor y esta implementacion depende de ella, que es la misma inversion
 * que aplica `message.repository.ts` respecto de `MessageRepository`.
 *
 * AISLAMIENTO ENTRE CLINICAS: ninguna de estas tres tablas tiene `clinic_id`.
 * La pertenencia se deriva por FK (`calls.conversation_id` ->
 * `conversations.clinic_id`; `audio_events.call_id` y
 * `latency_metrics.call_id` -> `calls`). Igual que en `message.repository.ts`,
 * la garantia que se hace cumplir desde aqui es ESTRUCTURAL: no hay ni un
 * `select` sin acotar por `id`, `session_id` o `call_id`, asi que ninguna fila
 * devuelta puede pertenecer a otra llamada -y por tanto a otra clinica- que la
 * solicitada. Quien pide el `sessionId` correcto es el gateway, que lo recibe
 * en `elevenlabs_extra_body` junto al `clinic_id` con el que el nucleo enruta.
 *
 * `disclosure_ejecutada` (obligacion contractual del proveedor, §7 de la
 * especificacion) se mapea siempre y se expone ademas con una operacion
 * propia, `marcarDisclosureEjecutada`, para que en el codigo se vea quien
 * afirma que la revelacion ocurrio.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActualizacionDeLlamada,
  AudioEvent,
  AudioEventTipo,
  CallRecord,
  CallRepository,
  CallStatus,
  LatencyMetric,
  NuevaLatencyMetric,
  NuevaLlamada,
  NuevoAudioEvent,
} from '../../channels/voice/voice.types.js';

// ---------------------------------------------------------------------------
// Filas crudas
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  conversation_id: string;
  session_id: string;
  elevenlabs_conversation_id: string | null;
  proveedor_sip: string | null;
  numero_origen: string | null;
  numero_destino: string | null;
  call_status: CallStatus;
  iniciada_en: string;
  finalizada_en: string | null;
  voice_duration_s: number | null;
  transferida_a: string | null;
  consentimiento_grabacion: boolean | null;
  retencion_audio: boolean | null;
  disclosure_ejecutada: boolean | null;
  updated_at: string | null;
}

interface AudioEventRow {
  id: string;
  call_id: string;
  tipo: AudioEventTipo;
  ts: string;
  payload: Record<string, unknown> | null;
}

interface LatencyMetricRow {
  id: string;
  call_id: string;
  turno: number;
  stt_ms: number | null;
  llm_ms: number | null;
  tts_ms: number | null;
  total_ms: number | null;
}

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

function mapCallRow(row: CallRow): CallRecord {
  const call: CallRecord = {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    callStatus: row.call_status,
    iniciadaEn: new Date(row.iniciada_en),
    // Los booleanos son `not null default false` en el esquema; el `?? false`
    // cubre una fila insertada por una via que no pasara por aqui.
    consentimientoGrabacion: row.consentimiento_grabacion ?? false,
    retencionAudio: row.retencion_audio ?? false,
    disclosureEjecutada: row.disclosure_ejecutada ?? false,
    updatedAt: new Date(row.updated_at ?? row.iniciada_en),
  };
  if (row.elevenlabs_conversation_id !== null) call.elevenlabsConversationId = row.elevenlabs_conversation_id;
  if (row.proveedor_sip !== null) call.proveedorSip = row.proveedor_sip;
  if (row.numero_origen !== null) call.numeroOrigen = row.numero_origen;
  if (row.numero_destino !== null) call.numeroDestino = row.numero_destino;
  if (row.finalizada_en !== null) call.finalizadaEn = new Date(row.finalizada_en);
  if (row.voice_duration_s !== null) call.voiceDurationS = row.voice_duration_s;
  if (row.transferida_a !== null) call.transferidaA = row.transferida_a;
  return call;
}

function mapAudioEventRow(row: AudioEventRow): AudioEvent {
  const evento: AudioEvent = {
    id: row.id,
    callId: row.call_id,
    tipo: row.tipo,
    ts: new Date(row.ts),
  };
  if (row.payload !== null) evento.payload = row.payload;
  return evento;
}

function mapLatencyMetricRow(row: LatencyMetricRow): LatencyMetric {
  const metrica: LatencyMetric = {
    id: row.id,
    callId: row.call_id,
    turno: row.turno,
  };
  if (row.stt_ms !== null) metrica.sttMs = row.stt_ms;
  if (row.llm_ms !== null) metrica.llmMs = row.llm_ms;
  if (row.tts_ms !== null) metrica.ttsMs = row.tts_ms;
  if (row.total_ms !== null) metrica.totalMs = row.total_ms;
  return metrica;
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export class SupabaseCallRepository implements CallRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findBySessionId(sessionId: string): Promise<CallRecord | null> {
    const { data, error } = await this.client
      .from('calls')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error) {
      throw new Error(`calls.findBySessionId fallo (session=${sessionId}): ${error.message}`);
    }
    const row = data as CallRow | null;
    return row ? mapCallRow(row) : null;
  }

  async findById(callId: string): Promise<CallRecord | null> {
    const { data, error } = await this.client.from('calls').select('*').eq('id', callId).maybeSingle();

    if (error) {
      throw new Error(`calls.findById fallo (call=${callId}): ${error.message}`);
    }
    const row = data as CallRow | null;
    return row ? mapCallRow(row) : null;
  }

  async create(nueva: NuevaLlamada): Promise<CallRecord> {
    const { data, error } = await this.client
      .from('calls')
      .insert({
        conversation_id: nueva.conversationId,
        session_id: nueva.sessionId,
        elevenlabs_conversation_id: nueva.elevenlabsConversationId ?? null,
        proveedor_sip: nueva.proveedorSip ?? null,
        numero_origen: nueva.numeroOrigen ?? null,
        numero_destino: nueva.numeroDestino ?? null,
        call_status: nueva.callStatus ?? 'iniciada',
        consentimiento_grabacion: nueva.consentimientoGrabacion ?? false,
        // Por defecto NO se retiene audio: es dato biometrico asociado a dato
        // de salud y activarlo «por si acaso» es el anti-patron 8.
        retencion_audio: nueva.retencionAudio ?? false,
        disclosure_ejecutada: nueva.disclosureEjecutada ?? false,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`calls.create fallo (session=${nueva.sessionId}): ${error.message}`);
    }
    return mapCallRow(data as CallRow);
  }

  async update(callId: string, cambios: ActualizacionDeLlamada): Promise<CallRecord> {
    // Solo viajan las claves informadas: `undefined` deja el valor como esta,
    // `null` lo borra. Sin esta distincion, un update parcial pisaria con null
    // los campos que consolida el webhook post-llamada.
    const patch: Record<string, unknown> = {};
    if (cambios.callStatus !== undefined) patch['call_status'] = cambios.callStatus;
    if (cambios.finalizadaEn !== undefined) {
      patch['finalizada_en'] = cambios.finalizadaEn === null ? null : cambios.finalizadaEn.toISOString();
    }
    if (cambios.voiceDurationS !== undefined) patch['voice_duration_s'] = cambios.voiceDurationS;
    if (cambios.transferidaA !== undefined) patch['transferida_a'] = cambios.transferidaA;
    if (cambios.elevenlabsConversationId !== undefined) {
      patch['elevenlabs_conversation_id'] = cambios.elevenlabsConversationId;
    }

    const { data, error } = await this.client
      .from('calls')
      .update(patch)
      .eq('id', callId)
      .select('*')
      .single();

    if (error) {
      throw new Error(`calls.update fallo (call=${callId}): ${error.message}`);
    }
    return mapCallRow(data as CallRow);
  }

  /**
   * Marca la revelacion obligatoria como ejecutada (§7). Es AUDITABLE y
   * criterio bloqueante de la Fase 5: no se combina con otros cambios en un
   * `update` generico a proposito, para que cada afirmacion de cumplimiento
   * quede visible en el codigo que la hace.
   */
  async marcarDisclosureEjecutada(callId: string): Promise<void> {
    const { error } = await this.client
      .from('calls')
      .update({ disclosure_ejecutada: true })
      .eq('id', callId);

    if (error) {
      throw new Error(`calls.marcarDisclosureEjecutada fallo (call=${callId}): ${error.message}`);
    }
  }

  async appendAudioEvent(evento: NuevoAudioEvent): Promise<AudioEvent> {
    const fila: Record<string, unknown> = {
      call_id: evento.callId,
      tipo: evento.tipo,
      payload: evento.payload ?? null,
    };
    // Sin `ts` explicito manda el `default now()` de la base, que es el reloj
    // correcto cuando el evento se registra en el momento en que ocurre.
    if (evento.ts !== undefined) fila['ts'] = evento.ts.toISOString();

    const { data, error } = await this.client.from('audio_events').insert(fila).select('*').single();

    if (error) {
      throw new Error(`audio_events.append fallo (call=${evento.callId}, tipo=${evento.tipo}): ${error.message}`);
    }
    return mapAudioEventRow(data as AudioEventRow);
  }

  async appendLatencyMetric(metrica: NuevaLatencyMetric): Promise<LatencyMetric> {
    const { data, error } = await this.client
      .from('latency_metrics')
      .insert({
        call_id: metrica.callId,
        turno: metrica.turno,
        // `stt_ms` y `tts_ms` llegan sin informar desde el gateway: los mide
        // ElevenLabs, no nosotros. Se guardan como NULL en vez de como 0 para
        // que el reporte de percentiles no promedie valores inventados.
        stt_ms: metrica.sttMs ?? null,
        llm_ms: metrica.llmMs ?? null,
        tts_ms: metrica.ttsMs ?? null,
        total_ms: metrica.totalMs ?? null,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`latency_metrics.append fallo (call=${metrica.callId}, turno=${metrica.turno}): ${error.message}`);
    }
    return mapLatencyMetricRow(data as LatencyMetricRow);
  }

  /**
   * Numero del proximo turno, derivado de cuantas metricas hay ya para la
   * llamada. Se cuenta con `head: true` (no trae filas).
   *
   * LIMITACION DECLARADA: no es transaccional. Dos turnos concurrentes de la
   * MISMA llamada podrian obtener el mismo numero. En una conversacion
   * telefonica los turnos son estrictamente secuenciales -no hay dos peticiones
   * del mismo `session_id` a la vez-, asi que el riesgo real es nulo; una
   * secuencia en la base seria la solucion definitiva si eso cambiara.
   */
  async siguienteTurno(callId: string): Promise<number> {
    const { count, error } = await this.client
      .from('latency_metrics')
      .select('id', { count: 'exact', head: true })
      .eq('call_id', callId);

    if (error) {
      throw new Error(`latency_metrics.siguienteTurno fallo (call=${callId}): ${error.message}`);
    }
    return (count ?? 0) + 1;
  }
}
