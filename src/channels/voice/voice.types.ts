/**
 * voice.types.ts
 *
 * Tipos y esquemas propios del canal de voz: la forma del request que envia
 * ElevenLabs a nuestro Custom LLM (interfaz OpenAI), la forma de los chunks
 * SSE que devolvemos, y los puertos de persistencia de `calls`, `transcripts`,
 * `audio_events` y `latency_metrics`.
 *
 * IMPORTANTE: nada de esto redefine un tipo del nucleo. `InboundMessage`,
 * `OutboundMessage`, `EscalationRequest`, `TurnChunk`, `Channel`,
 * `SystemToolName`... se importan siempre de `core/types/index.js` (regla 4 del
 * contrato de construccion). Este archivo describe el formato EXTERNO del
 * proveedor y las piezas de persistencia que la Fase 4 necesita.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LOS PUERTOS DE `calls`/`transcripts` VIVEN AQUI Y NO EN `ports.ts`
 * ---------------------------------------------------------------------------
 * `src/core/types/ports.ts` es un contrato CONGELADO y compartido por varias
 * ramas: no define (ni puede definir ahora) puertos para `calls`,
 * `transcripts`, `audio_events` ni `latency_metrics`. Ademas son conceptos
 * exclusivos del canal de voz: una llamada telefonica no existe en WhatsApp, y
 * meterlos en el nucleo obligaria al nucleo a conocer la telefonia.
 *
 * Por eso las interfaces se declaran aqui, del lado del CONSUMIDOR (el
 * gateway), y las implementaciones sobre Supabase
 * (`src/infra/repositories/call.repository.ts` y `transcript.repository.ts`)
 * dependen de estas interfaces. Es la misma inversion de dependencias que
 * aplica `infra/repositories/message.repository.ts` respecto de
 * `MessageRepository` en `ports.ts`, solo que el puerto vive en el canal en vez
 * de en el nucleo. Queda declarado como VACIO DETECTADO en el informe final.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Request entrante — forma OpenAI (docs/contrato-elevenlabs.md §1)
// ---------------------------------------------------------------------------

/**
 * Un mensaje del array `messages`.
 *
 * ASUNCION (docs/contrato-elevenlabs.md §3): el ejemplo oficial solo define
 * `{role, content}`. Los campos de round-trip de tool calling (`tool_calls[]`
 * en un mensaje `assistant`, `tool_call_id` en un mensaje `role: "tool"`) NO
 * estan documentados por el proveedor: se asume el estandar de OpenAI. Se
 * aceptan de forma laxa porque este gateway NO los interpreta -- el historial
 * autoritativo es nuestra base (anti-patron 6) y de este array solo se usa el
 * ultimo mensaje de usuario como senal del turno en curso.
 */
export const openAiMessageSchema = z
  .object({
    role: z.string().min(1),
    /** `null` es legitimo en OpenAI cuando el mensaje solo lleva `tool_calls`. */
    content: z.union([z.string(), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type OpenAiMessage = z.infer<typeof openAiMessageSchema>;

/**
 * `elevenlabs_extra_body`: CONFIRMADO como nombre exacto del campo
 * (docs/contrato-elevenlabs.md §1). No es un campo valido de la API de OpenAI;
 * lo llenamos NOSOTROS al iniciar la conversacion
 * (`ConversationConfig(extra_body=...)`), asi que los nombres de las claves de
 * dentro son decision nuestra, no del proveedor.
 *
 * Claves canonicas: `clinic_id`, `session_id`, `phone`. Los alias se aceptan a
 * proposito: si quien configure el agente en el panel escribe `caller_id` o
 * `patient_phone`, una llamada real no debe caerse por un nombre de clave.
 */
export const elevenlabsExtraBodySchema = z
  .object({
    clinic_id: z.string().optional(),
    session_id: z.string().optional(),
    phone: z.string().optional(),
    // Alias tolerados. Ver comentario de arriba.
    patient_phone: z.string().optional(),
    telefono: z.string().optional(),
    caller_id: z.string().optional(),
    from_number: z.string().optional(),
    conversation_id: z.string().optional(),
  })
  .passthrough();
export type ElevenlabsExtraBody = z.infer<typeof elevenlabsExtraBodySchema>;

export const voiceChatCompletionRequestSchema = z
  .object({
    messages: z.array(openAiMessageSchema).default([]),
    model: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    stream: z.boolean().optional(),
    user_id: z.string().optional(),
    elevenlabs_extra_body: elevenlabsExtraBodySchema.optional(),
    /** System tools en formato OpenAI. Se ignoran: la lista la fija el agente, no el LLM. */
    tools: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type VoiceChatCompletionRequest = z.infer<typeof voiceChatCompletionRequestSchema>;

/**
 * Ultimo mensaje de USUARIO del array. Es lo unico que se toma de `messages`:
 * el historial autoritativo se lee de nuestra base (anti-patron 6), y este
 * array solo sirve como senal del turno actual.
 */
export function ultimoMensajeDeUsuario(mensajes: readonly OpenAiMessage[]): string | undefined {
  for (let i = mensajes.length - 1; i >= 0; i -= 1) {
    const m = mensajes[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    if (m.content.trim() === '') continue;
    return m.content;
  }
  return undefined;
}

/** Primer alias no vacio del telefono dentro de `elevenlabs_extra_body`. */
export function telefonoDeExtraBody(extra: ElevenlabsExtraBody | undefined): string | undefined {
  if (!extra) return undefined;
  const candidatos = [extra.phone, extra.patient_phone, extra.telefono, extra.caller_id, extra.from_number];
  for (const c of candidatos) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return undefined;
}

/**
 * Normaliza a E.164. Misma forma exacta que exige `inboundMessageSchema` del
 * nucleo: si no encaja, se devuelve `undefined` en vez de construir un
 * `InboundMessage` que el nucleo rechazaria mas adelante.
 *
 * No se usa `libphonenumber-js` a proposito: el caller ID de una llamada
 * telefonica ya llega en formato internacional, no hay region que desambiguar.
 */
export function aE164(bruto: string | undefined): string | undefined {
  if (!bruto) return undefined;
  const digitos = bruto.replace(/[^0-9]/g, '');
  if (digitos.length === 0) return undefined;
  const candidato = `+${digitos}`;
  return /^\+[1-9]\d{7,14}$/.test(candidato) ? candidato : undefined;
}

// ---------------------------------------------------------------------------
// 2. Response SSE — forma `chat.completion.chunk` (docs/contrato-elevenlabs.md §3)
// ---------------------------------------------------------------------------

/**
 * Fragmento de un `tool_call` dentro de un delta.
 *
 * El FORMATO DE STREAMING de `tool_calls` no esta documentado por el proveedor.
 * La asuncion (y el unico sitio donde se construye) esta en
 * `openai-sse.mapper.ts`. Aqui solo se declara la forma.
 */
export interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OpenAiChunkDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: OpenAiToolCallDelta[];
}

export type OpenAiFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;

export interface OpenAiChunkChoice {
  index: number;
  delta: OpenAiChunkDelta;
  finish_reason: OpenAiFinishReason;
}

export interface OpenAiChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
}

/** Lo invariante de todos los chunks de una misma respuesta. */
export interface ContextoDeChunk {
  id: string;
  model: string;
  /** Segundos desde epoch, como en OpenAI (no milisegundos). */
  created: number;
}

// ---------------------------------------------------------------------------
// 3. Persistencia del canal de voz
// ---------------------------------------------------------------------------

export const callStatusSchema = z.enum([
  'iniciada',
  'en_curso',
  'transferida',
  'finalizada',
  'fallida',
]);
export type CallStatus = z.infer<typeof callStatusSchema>;

/** Fila de `calls` en dominio (camelCase). Espeja 001_init.sql. */
export interface CallRecord {
  id: string;
  conversationId: string;
  sessionId: string;
  elevenlabsConversationId?: string;
  proveedorSip?: string;
  numeroOrigen?: string;
  numeroDestino?: string;
  callStatus: CallStatus;
  iniciadaEn: Date;
  finalizadaEn?: Date;
  voiceDurationS?: number;
  transferidaA?: string;
  consentimientoGrabacion: boolean;
  retencionAudio: boolean;
  /**
   * OBLIGACION CONTRACTUAL DEL PROVEEDOR (§7 de la especificacion,
   * docs/contrato-elevenlabs.md §6) y criterio BLOQUEANTE de la Fase 5.
   * Es el unico rastro auditable de que se aviso al paciente de que habla con
   * una IA y de que la llamada se graba. Nunca se marca "por si acaso": ver
   * `marcarDisclosureEjecutada`.
   */
  disclosureEjecutada: boolean;
  updatedAt: Date;
}

export interface NuevaLlamada {
  conversationId: string;
  sessionId: string;
  elevenlabsConversationId?: string;
  proveedorSip?: string;
  numeroOrigen?: string;
  numeroDestino?: string;
  callStatus?: CallStatus;
  consentimientoGrabacion?: boolean;
  retencionAudio?: boolean;
  disclosureEjecutada?: boolean;
}

/** Campos mutables de una llamada. `null` borra el valor; `undefined` lo deja igual. */
export interface ActualizacionDeLlamada {
  callStatus?: CallStatus;
  finalizadaEn?: Date | null;
  voiceDurationS?: number | null;
  transferidaA?: string | null;
  elevenlabsConversationId?: string | null;
}

export const audioEventTipoSchema = z.enum([
  'inicio',
  'barge_in',
  'silencio',
  'reintento_comprension',
  'transferencia',
  'fin',
]);
export type AudioEventTipo = z.infer<typeof audioEventTipoSchema>;

export interface AudioEvent {
  id: string;
  callId: string;
  tipo: AudioEventTipo;
  ts: Date;
  payload?: Record<string, unknown>;
}

export interface NuevoAudioEvent {
  callId: string;
  tipo: AudioEventTipo;
  ts?: Date;
  /** NUNCA lleva PII sin enmascarar: se persiste tal cual (regla 8 del contrato). */
  payload?: Record<string, unknown>;
}

export interface LatencyMetric {
  id: string;
  callId: string;
  turno: number;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs?: number;
}

export interface NuevaLatencyMetric {
  callId: string;
  turno: number;
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs?: number;
}

export interface CallRepository {
  /** Clave de entrada del gateway: `session_id` viaja en `elevenlabs_extra_body`. */
  findBySessionId(sessionId: string): Promise<CallRecord | null>;
  findById(callId: string): Promise<CallRecord | null>;
  create(nueva: NuevaLlamada): Promise<CallRecord>;
  update(callId: string, cambios: ActualizacionDeLlamada): Promise<CallRecord>;
  /**
   * Marca el flag auditable de revelacion. Se expone como operacion PROPIA (no
   * como un campo mas de `update`) para que en el codigo se vea siempre quien
   * afirma que la revelacion ocurrio, y con que evidencia.
   */
  marcarDisclosureEjecutada(callId: string): Promise<void>;
  appendAudioEvent(evento: NuevoAudioEvent): Promise<AudioEvent>;
  appendLatencyMetric(metrica: NuevaLatencyMetric): Promise<LatencyMetric>;
  /** Numero del proximo turno de la llamada (1-based), derivado de `latency_metrics`. */
  siguienteTurno(callId: string): Promise<number>;
}

export const hablanteSchema = z.enum(['paciente', 'agente']);
export type Hablante = z.infer<typeof hablanteSchema>;

export interface TranscriptLine {
  id: string;
  callId: string;
  hablante: Hablante;
  texto: string;
  tsInicioMs?: number;
  tsFinMs?: number;
  confianza?: number;
}

export interface NuevaLineaDeTranscripcion {
  callId: string;
  hablante: Hablante;
  texto: string;
  tsInicioMs?: number;
  tsFinMs?: number;
  confianza?: number;
}

export interface TranscriptRepository {
  append(linea: NuevaLineaDeTranscripcion): Promise<TranscriptLine>;
  appendMany(lineas: readonly NuevaLineaDeTranscripcion[]): Promise<TranscriptLine[]>;
  listByCall(callId: string): Promise<TranscriptLine[]>;
}
