import { z } from 'zod';
import { channelSchema, type Channel } from './channel.js';

/** Motivos de escalamiento. Cerrados: anadir uno obliga a revisar el prompt (bloque 6). */
export const escalationReasonSchema = z.enum([
  'urgencia',
  'peticion_humano',
  'reclamo',
  'fallo_comprension',
]);
export type EscalationReason = z.infer<typeof escalationReasonSchema>;

export const escalationPrioritySchema = z.enum(['urgente', 'normal']);
export type EscalationPriority = z.infer<typeof escalationPrioritySchema>;

/**
 * Peticion de escalamiento a humano.
 *
 * `transferNumber` NUNCA se usa sin validarlo antes contra
 * `clinics.transfer_whitelist`. La validacion vive en la herramienta
 * `escalar_humano`, no en quien construye este objeto.
 */
export interface EscalationRequest {
  reason: EscalationReason;
  priority: EscalationPriority;
  /** Resumen para la persona que recibe el caso. En voz -> agent_message de transfer_to_number. */
  summaryForAgent: string;
  /** Lo que se le dice al paciente. En voz -> client_message de transfer_to_number. */
  messageForPatient: string;
  /** SIEMPRE validado contra clinic.transfer_whitelist antes de usarse. */
  transferNumber?: string;
}

export const escalationRequestSchema: z.ZodType<EscalationRequest> = z.object({
  reason: escalationReasonSchema,
  priority: escalationPrioritySchema,
  summaryForAgent: z.string().min(1),
  messageForPatient: z.string().min(1),
  transferNumber: z.string().optional(),
});

/** Mensaje entrante, ya normalizado por el adaptador de canal. */
export interface InboundMessage {
  clinicId: string;
  /** Telefono normalizado a E.164. Es la clave de identidad del paciente. */
  patientPhoneE164: string;
  patientName?: string;
  text: string;
  channel: Channel;
  /** Voz: id de la llamada. Texto: ventana de chat. */
  sessionId?: string;
  receivedAt: Date;
}

export const inboundMessageSchema: z.ZodType<InboundMessage> = z.object({
  clinicId: z.string().uuid(),
  patientPhoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'debe ser E.164, p. ej. +51987654321'),
  patientName: z.string().optional(),
  text: z.string(),
  channel: channelSchema,
  sessionId: z.string().optional(),
  receivedAt: z.date(),
});

/**
 * Respuesta del nucleo. `text` es texto PURO: el adaptador aplica el formato
 * propio del canal. El nucleo no emite markdown, ni emojis, ni SSML.
 */
export interface OutboundMessage {
  conversationId: string;
  text: string;
  channel: Channel;
  escalate?: EscalationRequest;
  endCall?: boolean;
  latencyMs: number;
}

export const outboundMessageSchema: z.ZodType<OutboundMessage> = z.object({
  conversationId: z.string().uuid(),
  text: z.string(),
  channel: channelSchema,
  escalate: escalationRequestSchema.optional(),
  endCall: z.boolean().optional(),
  latencyMs: z.number().int().nonnegative(),
});

/** Rol de un mensaje persistido. */
export const messageRolSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRol = z.infer<typeof messageRolSchema>;

/** Fila de `messages` tal como vive en la base. */
export interface StoredMessage {
  id: string;
  conversationId: string;
  rol: MessageRol;
  contenido: string;
  canal: Channel;
  sessionId?: string;
  tokensIn?: number;
  tokensOut?: number;
  latenciaMs?: number;
  creadoEn: Date;
}
