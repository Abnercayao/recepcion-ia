import { z } from 'zod';
import type { Channel } from './channel.js';
import type {
  EscalationRequest,
  InboundMessage,
  OutboundMessage,
  StoredMessage,
} from './message.js';

export const conversationEstadoSchema = z.enum(['activa', 'escalada', 'cerrada']);
export type ConversationEstado = z.infer<typeof conversationEstadoSchema>;

/**
 * Una conversacion es de un paciente en una clinica, NO de un canal.
 * El mismo `id` sobrevive al salto de voz a WhatsApp y viceversa dentro de la
 * ventana de continuidad. Es la clave de la continuidad multicanal.
 */
export interface Conversation {
  id: string;
  clinicId: string;
  patientId: string;
  estado: ConversationEstado;
  canalOrigen: Channel;
  ultimoCanal: Channel;
  iniciadaEn: Date;
  ultimaActividad: Date;
  escaladaEn?: Date;
  escaladaMotivo?: string;
}

export interface Patient {
  id: string;
  clinicId: string;
  telefonoE164: string;
  nombre?: string;
  consentimientoAt?: Date;
  consentimientoCanal?: string;
}

export interface Clinic {
  id: string;
  nombre: string;
  timezone: string;
  config: Record<string, unknown>;
  retencionTranscripcionDias: number;
  retencionAudioDias: number;
  /** Lista blanca de numeros de transferencia. Fuera de aqui no se transfiere. */
  transferWhitelist: string[];
}

/**
 * Contexto del turno en curso. Lo construye el MessageRouter y lo consumen el
 * PromptBuilder, las herramientas y los guardrails. Es lo unico que las capas
 * inferiores necesitan saber del turno.
 */
export interface TurnContext {
  conversationId: string;
  clinic: Clinic;
  patient: Patient;
  channel: Channel;
  sessionId?: string;
  /** Historial autoritativo, leido SIEMPRE de la base propia. */
  history: StoredMessage[];
  /** True si el canal cambio respecto del mensaje anterior: el agente debe anunciarlo. */
  channelSwitched: boolean;
  /** Fallos de comprension consecutivos. A los 2 se ofrece salida alternativa. */
  comprehensionFailures: number;
  /** Fecha y hora del sistema en la zona de la clinica. Sin esto el agente agenda mal. */
  now: Date;
}

/**
 * Fragmento emitido durante un turno en streaming.
 * El canal de voz lo consume para emitir SSE progresivamente; sin streaming la
 * latencia percibida arruina la conversacion.
 */
export type TurnChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'escalate'; request: EscalationRequest }
  | { type: 'done'; message: OutboundMessage };

/**
 * EL servicio de conversacion. Uno solo, comun a los dos canales.
 * `streamTurn` es obligatorio: lo requiere el canal de voz.
 */
export interface ConversationService {
  handleTurn(input: InboundMessage): Promise<OutboundMessage>;
  streamTurn(input: InboundMessage): AsyncIterable<TurnChunk>;
}
