/**
 * PUERTOS: las fronteras del nucleo.
 *
 * El nucleo depende de estas interfaces, nunca de implementaciones concretas.
 * Eso es lo que permite (a) que Supabase, Google Calendar o el proveedor de
 * embeddings se sustituyan sin reescribir logica, (b) que los tests corran sin
 * servicios externos, y (c) que la especificacion se cumpla: `core/` no importa
 * de `channels/` ni de `infra/`.
 *
 * ESTE ARCHIVO ES EL CONTRATO COMPARTIDO. No lo modifiques sin avisar: hay
 * varias ramas de trabajo dependiendo de el simultaneamente.
 */
import type { Channel } from './channel.js';
import type { Clinic, Conversation, Patient, TurnContext } from './conversation.js';
import type { EscalationRequest, MessageRol, StoredMessage } from './message.js';
import type { ToolCallRecord } from './tool.js';

// ---------------------------------------------------------------------------
// Observabilidad
// ---------------------------------------------------------------------------

/**
 * Logger estructurado. TODA escritura pasa antes por el enmascarador de PII:
 * quien implemente este puerto es responsable de que no salga un DNI ni un
 * telefono en claro (control C6).
 */
export interface Logger {
  fatal(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Fragmento del stream del modelo, ya normalizado (no es el formato del SDK). */
export type ClaudeStreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; toolUse: ClaudeToolUse }
  | { type: 'end'; stopReason: string; tokensIn: number; tokensOut: number };

export interface ClaudeCallOptions {
  system: string;
  messages: ClaudeMessage[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Esquema JSON que el PROVEEDOR obliga a cumplir en la respuesta (salidas
   * estructuradas). No es una peticion en el prompt: si se manda, la respuesta
   * no puede venir envuelta en markdown, ni faltarle un campo, ni traer un
   * valor fuera del enum.
   *
   * Viaja como dato a proposito. Quien lo consume es `claude.service.ts`, el
   * unico punto que conoce el SDK; el nucleo no importa nada del proveedor
   * para poder usarlo. Requiere `additionalProperties: false` y `required`
   * completo en cada objeto del esquema.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * Puerto del modelo. Encapsular la invocacion aqui es lo que hace que sustituir
 * el proveedor sea configuracion y no reescritura (decision de §3.1.2.B).
 */
export interface ClaudePort {
  /** Respuesta completa. Usado por clasificacion y por tareas internas. */
  complete(opts: ClaudeCallOptions): Promise<{ text: string; toolUses: ClaudeToolUse[] }>;
  /** Respuesta en streaming. Obligatorio para el canal de voz. */
  stream(opts: ClaudeCallOptions): AsyncIterable<ClaudeStreamChunk>;
}

// ---------------------------------------------------------------------------
// Conocimiento
// ---------------------------------------------------------------------------

export interface KnowledgeChunk {
  id: string;
  clinicId: string;
  contenido: string;
  fuente: 'formulario' | 'web' | 'faq' | 'protocolo_urgencia';
  similarity?: number;
}

export interface EmbeddingPort {
  /** Devuelve un vector por cada texto, en el mismo orden. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
  readonly dimensions: number;
}

export interface RagPort {
  /**
   * Recupera fragmentos APROBADOS y ACTIVOS de la clinica indicada.
   * Nunca cruza clinicas: el aislamiento es absoluto (control C9).
   */
  retrieve(clinicId: string, query: string, limit?: number): Promise<KnowledgeChunk[]>;
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

export interface CalendarSlot {
  start: Date;
  end: Date;
  profesional?: string;
}

export interface CalendarEvent {
  id: string;
  start: Date;
  end: Date;
  titulo: string;
  profesional?: string;
}

export interface CalendarPort {
  /** Disponibilidad REAL. Nunca se ofrece un horario que no se comprobo. */
  findAvailableSlots(clinicId: string, from: Date, to: Date, durationMin: number): Promise<CalendarSlot[]>;
  /** Comprobacion de colision inmediatamente antes de escribir (control C7). */
  isSlotFree(clinicId: string, start: Date, end: Date): Promise<boolean>;
  createEvent(clinicId: string, event: Omit<CalendarEvent, 'id'>, patientPhone: string): Promise<CalendarEvent>;
  cancelEvent(clinicId: string, eventId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Notificacion (escalamiento hacia la recepcion humana)
// ---------------------------------------------------------------------------

export interface NotificationPort {
  /**
   * Canal de respaldo cuando la transferencia telefonica no es posible o el
   * numero no esta en la lista blanca. El modo de fallo del sistema es la
   * reversion a la operacion manual, NUNCA el silencio (control O5).
   */
  notifyEscalation(ctx: TurnContext, request: EscalationRequest): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

export interface ClinicRepository {
  findById(clinicId: string): Promise<Clinic | null>;
}

export interface PatientRepository {
  /** upsert por (clinic_id, telefono_e164). El telefono es la clave de identidad. */
  upsert(clinicId: string, telefonoE164: string, nombre?: string): Promise<Patient>;
}

export interface ConversationRepository {
  /** Conversacion activa dentro de la ventana de continuidad, sea cual sea el canal. */
  findActiveWithin(clinicId: string, patientId: string, since: Date): Promise<Conversation | null>;
  create(clinicId: string, patientId: string, canal: Channel): Promise<Conversation>;
  touch(conversationId: string, ultimoCanal: Channel): Promise<void>;
  markEscalated(conversationId: string, motivo: string): Promise<void>;
}

export interface MessageRepository {
  append(msg: {
    conversationId: string;
    rol: MessageRol;
    contenido: string;
    canal: Channel;
    sessionId?: string;
    tokensIn?: number;
    tokensOut?: number;
    latenciaMs?: number;
  }): Promise<StoredMessage>;
  /** Historial autoritativo. La fuente de verdad es esta base, no ElevenLabs. */
  listByConversation(conversationId: string, limit?: number): Promise<StoredMessage[]>;
}

export interface ToolCallRepository {
  record(call: ToolCallRecord): Promise<void>;
  /** Para hacer cumplir maxCallsPerConversation. */
  countByTool(conversationId: string, herramienta: string): Promise<number>;
}

export interface AuditRepository {
  log(evento: string, detalle: Record<string, unknown>, clinicId?: string, conversationId?: string): Promise<void>;
}
