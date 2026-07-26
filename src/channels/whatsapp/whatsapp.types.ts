/**
 * whatsapp.types.ts
 *
 * Tipos y esquemas propios del canal WhatsApp: la forma del payload de la
 * WhatsApp Cloud API (webhook entrante y respuesta de envio), y utilidades
 * de enrutamiento/deduplicacion que solo le importan a este canal.
 *
 * IMPORTANTE: nada de esto es un tipo del nucleo. `InboundMessage`,
 * `OutboundMessage`, `EscalationRequest`, etc. se importan siempre de
 * `core/types/index.js` y NUNCA se redefinen aqui (regla del contrato de
 * construccion). Este archivo solo describe el formato externo de Meta y las
 * piezas de traduccion/enrutamiento que necesita el adaptador.
 */
import { z } from 'zod';
import type { OutboundMessage } from '../../core/types/index.js';

// ---------------------------------------------------------------------------
// Limites de la API de envio (Cloud API)
// ---------------------------------------------------------------------------

/** Limite documentado de la Cloud API de WhatsApp para el cuerpo de un mensaje de texto. */
export const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Webhook entrante (POST) — forma de Meta, verificada contra la documentacion
// publica de WhatsApp Cloud API. Se usa `.passthrough()` en todo objeto para
// no romper si Meta agrega campos nuevos: solo leemos lo que necesitamos.
// ---------------------------------------------------------------------------

const whatsappProfileSchema = z.object({ name: z.string().optional() }).passthrough();

const whatsappContactSchema = z
  .object({
    profile: whatsappProfileSchema.optional(),
    wa_id: z.string().optional(),
  })
  .passthrough();

const whatsappTextBodySchema = z.object({ body: z.string() });

/**
 * Union abierta a proposito: el campo `type` es lo unico que decide como se
 * procesa un mensaje. Solo 'text' se traduce a InboundMessage; el resto
 * (image, audio, sticker, reaction, button, interactive, location, document,
 * video, contacts, order, system, unknown...) se deja pasar con forma
 * generica porque el controller los ignora sin fallar — no son mensajes de
 * texto entrantes (Encargo 1).
 */
export const whatsappMessageSchema = z
  .object({
    from: z.string().min(1),
    id: z.string().min(1),
    timestamp: z.string().optional(),
    type: z.string().min(1),
    text: whatsappTextBodySchema.optional(),
  })
  .passthrough();
export type WhatsappMessage = z.infer<typeof whatsappMessageSchema>;

const whatsappMetadataSchema = z
  .object({
    display_phone_number: z.string().optional(),
    /** Clave real de enrutamiento en Meta: un webhook de App puede recibir eventos de varios numeros/clinicas. */
    phone_number_id: z.string().min(1),
  })
  .passthrough();

const whatsappChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: whatsappMetadataSchema,
    contacts: z.array(whatsappContactSchema).optional(),
    messages: z.array(whatsappMessageSchema).optional(),
    /**
     * Estados de entrega (sent/delivered/read/failed). Llegan en un array
     * separado de `messages`, nunca como mensaje. Se aceptan (para no fallar
     * el parseo) pero no se traducen a nada: el controller los ignora.
     */
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

const whatsappChangeSchema = z
  .object({
    value: whatsappChangeValueSchema,
    field: z.string().optional(),
  })
  .passthrough();

const whatsappEntrySchema = z
  .object({
    id: z.string().optional(),
    changes: z.array(whatsappChangeSchema).default([]),
  })
  .passthrough();

export const whatsappWebhookPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(whatsappEntrySchema).default([]),
  })
  .passthrough();
export type WhatsappWebhookPayload = z.infer<typeof whatsappWebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Deduplicacion por message.id (responsabilidad del controller, Encargo 1)
// ---------------------------------------------------------------------------

/**
 * Puerto minimo para no reprocesar un mensaje ya visto. Se define AQUI (no en
 * core/types/ports.ts) porque es un detalle propio de como Meta reintenta
 * ESTE webhook, no un puerto del nucleo compartido entre canales.
 */
export interface MessageDedupeStore {
  has(messageId: string): boolean;
  markSeen(messageId: string): void;
}

/**
 * Implementacion en memoria con limite de tamano (evita crecer sin cota en un
 * proceso de larga duracion; desaloja el mas antiguo tipo FIFO).
 *
 * LIMITACION ACEPTADA PARA v1 (declararla en el informe final): no sobrevive
 * un reinicio del proceso ni se comparte entre replicas de un despliegue
 * horizontal. Un reinicio en el peor caso reprocesa un mensaje que ya se
 * habia procesado antes de caerse; no se pierde ninguno. Para produccion
 * multi-instancia hay que respaldar esto en algo compartido (Redis, tabla
 * propia con UNIQUE sobre message_id).
 */
export class InMemoryDedupeStore implements MessageDedupeStore {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize: number = 10_000) {}

  has(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  markSeen(messageId: string): void {
    if (this.seen.has(messageId)) return;
    this.seen.add(messageId);
    this.order.push(messageId);
    if (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Enrutamiento por clinica (vacio de la especificacion, ver informe final)
// ---------------------------------------------------------------------------

/**
 * Lo que el controller necesita para procesar un mensaje de un
 * `phone_number_id` dado: a que clinica pertenece (para construir el
 * `InboundMessage`, que exige `clinicId` como UUID) y por donde se envia la
 * respuesta (el adaptador ya configurado con el token/numero de ESA clinica).
 *
 * VACIO DETECTADO: `InboundMessage.clinicId` y `OutboundMessage` (contratos
 * congelados) no llevan ninguna pista de a que clinica pertenece un mensaje
 * de WhatsApp: esa asociacion vive fuera del nucleo, en la infraestructura de
 * Meta (`phone_number_id`). Un webhook de WhatsApp Cloud API se suscribe a
 * nivel de App/WABA, no de numero — un mismo endpoint puede recibir eventos
 * de varias clinicas con numeros distintos. Por eso este resolver, inyectado
 * por quien componga el sistema (Ola 4 / server.ts), en vez de un valor
 * estatico: para una sola clinica basta con ignorar el argumento y devolver
 * siempre la misma respuesta.
 */
export interface WhatsappClinicRouting {
  clinicId: string;
  outboundSender: WhatsappOutboundSender;
}

export type ResolveWhatsappRouting = (phoneNumberId: string) => Promise<WhatsappClinicRouting | undefined>;

/** Lo unico que el controller necesita del adaptador de envio (Encargo 3). Desacopla el test del controller de la implementacion real. */
export interface WhatsappOutboundSender {
  sendOutbound(patientPhoneE164: string, outbound: OutboundMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Envio saliente — Cloud API (POST /{phone_number_id}/messages)
// ---------------------------------------------------------------------------

export interface WhatsappSendTextRequest {
  messaging_product: 'whatsapp';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export const whatsappSendResponseSchema = z
  .object({
    messaging_product: z.string().optional(),
    contacts: z
      .array(z.object({ input: z.string().optional(), wa_id: z.string().optional() }).passthrough())
      .optional(),
    messages: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  })
  .passthrough();
export type WhatsappSendResponse = z.infer<typeof whatsappSendResponseSchema>;
