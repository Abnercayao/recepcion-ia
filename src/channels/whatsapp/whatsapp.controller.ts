/**
 * whatsapp.controller.ts
 *
 * Ruta Fastify del webhook entrante de la WhatsApp Cloud API (via BSP).
 * Traduce, no decide (anti-patron 2): valida la firma, filtra lo que no es
 * un mensaje de texto, deduplica por `message.id`, arma un `InboundMessage`
 * y se lo pasa al `ConversationService` inyectado. La decision de que
 * responder la toma el nucleo; este archivo solo transporta esa respuesta
 * de vuelta a Meta a traves del `WhatsappOutboundSender` inyectado.
 *
 * ENDPOINTS (montados en la raiz del plugin; quien componga decide el
 * prefijo, p. ej. `app.register(whatsappWebhookPlugin, { ...deps, prefix:
 * '/webhooks/whatsapp' })`):
 *  - GET  /  verificacion del webhook (hub.mode / hub.verify_token / hub.challenge).
 *  - POST /  mensajes entrantes.
 *
 * CUERPO CRUDO PARA LA FIRMA: Fastify parsea JSON por defecto y no expone el
 * buffer original. La firma `X-Hub-Signature-256` es un HMAC sobre el
 * cuerpo EXACTO tal como lo mando Meta (bytes, no el objeto ya parseado y
 * reserializado, que puede diferir en espacios/orden de claves). Se resuelve
 * reemplazando el content-type parser de 'application/json' con uno propio
 * (`addContentTypeParser(..., { parseAs: 'buffer' }, ...)`) que:
 *   1. guarda el string crudo en `request.rawBody` (propiedad agregada via
 *      augmentacion de modulo, ver mas abajo);
 *   2. hace el `JSON.parse` el mismo (Fastify ya no lo hace por nosotros).
 * Esto se registra DENTRO del plugin (no en el `app` raiz que reciba quien
 * componga), asi que por la encapsulacion por defecto de Fastify **no
 * afecta el parseo JSON de ninguna otra ruta** del servidor compuesto en
 * Ola 4 -- solo el sub-contexto de este plugin la usa.
 *
 * ACK INMEDIATO: se responde 200 apenas la firma es valida, ANTES de invocar
 * al nucleo. Meta reintenta el webhook si la respuesta tarda demasiado, y un
 * reintento entrega el mismo mensaje otra vez -- de ahi la deduplicacion por
 * `message.id`. El procesamiento real (`handleWhatsAppWebhookEvent`) sigue
 * despues de responder, sin bloquear el ACK; se exporta por separado
 * precisamente para poder probarlo de forma determinista sin depender de
 * los tiempos de Fastify tras un `reply.send()`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ConversationService, InboundMessage, Logger } from '../../core/types/index.js';
import {
  InMemoryDedupeStore,
  whatsappWebhookPayloadSchema,
  type MessageDedupeStore,
  type ResolveWhatsappRouting,
  type WhatsappMessage,
} from './whatsapp.types.js';

// Augmentacion de modulo: `rawBody` no existe en FastifyRequest de fabrica.
// Se agrega aqui, en el unico archivo que la produce (el content type
// parser custom de mas abajo) y la consume.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

// ---------------------------------------------------------------------------
// Verificacion de firma X-Hub-Signature-256
// ---------------------------------------------------------------------------

export interface SignatureVerificationResult {
  valid: boolean;
  /** Motivo legible para loguear el rechazo. Nunca incluye el secreto ni el cuerpo. */
  reason?: string;
}

/**
 * Verifica la firma HMAC-SHA256 que Meta adjunta en `X-Hub-Signature-256`
 * (forma `sha256=<hex>`), calculada sobre el cuerpo crudo con el secreto de
 * la app. Comparacion en tiempo constante con `timingSafeEqual`, mismo
 * patron que src/infra/elevenlabs.client.ts.
 */
export function verifyWhatsappWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string,
): SignatureVerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: 'falta el header X-Hub-Signature-256' };
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return { valid: false, reason: 'header X-Hub-Signature-256 con formato invalido (se esperaba sha256=...)' };
  }

  const received = signatureHeader.slice(prefix.length);
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');

  if (receivedBuffer.length === 0 || expectedBuffer.length !== receivedBuffer.length) {
    return { valid: false, reason: 'la firma HMAC no coincide' };
  }
  if (!timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return { valid: false, reason: 'la firma HMAC no coincide' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Dependencias inyectadas
// ---------------------------------------------------------------------------

export interface WhatsappControllerDeps {
  /** NUNCA se instancia aqui: se recibe ya construido (regla del Encargo 1). */
  conversationService: ConversationService;
  logger: Logger;
  /**
   * Token de verificacion del webhook (challenge GET). En la composicion
   * final corresponde a `config.WHATSAPP_WEBHOOK_SECRET`.
   */
  verifyToken: string;
  /**
   * Secreto para el HMAC de `X-Hub-Signature-256`. En Meta real, este es el
   * "App Secret" de la app de Meta -- una credencial DISTINTA del token de
   * verificacion del challenge GET (`verifyToken` arriba). VACIO DETECTADO:
   * `src/infra/config.ts` (fuera de mi alcance) solo define
   * `WHATSAPP_WEBHOOK_SECRET`, sin una variable separada para el App Secret.
   * Se acepta aqui como campo independiente para no forzar dos secretos de
   * proposito distinto bajo un mismo nombre; quien componga (Ola 4) decide
   * si reutiliza el mismo valor (funciona, pero mezcla dos conceptos) o
   * anade una variable nueva (recomendado: WHATSAPP_APP_SECRET). Ver informe final.
   */
  appSecret: string;
  /** Resuelve a que clinica pertenece un `phone_number_id` y por donde responderle. Ver whatsapp.types.ts. */
  resolveRouting: ResolveWhatsappRouting;
  /** Por defecto, deduplicacion en memoria (ver InMemoryDedupeStore). Inyectable para tests y para un store compartido en produccion. */
  dedupeStore?: MessageDedupeStore;
  /** Reloj inyectable: solo se usa como respaldo si el timestamp del mensaje no es parseable. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Content type parser con cuerpo crudo
// ---------------------------------------------------------------------------

function registerRawBodyJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, payload, done) => {
    const raw = payload.toString('utf8');
    request.rawBody = raw;

    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch {
      done(new Error('whatsapp webhook: cuerpo no es JSON valido'), undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Traduccion de payload -> InboundMessage + orquestacion del turno
// ---------------------------------------------------------------------------

/**
 * `message.from` en la Cloud API es el numero completo en formato
 * internacional SIN el signo `+` (Meta ya lo entrega inequivoco, a
 * diferencia de un numero local ambiguo); anteponerlo basta. No hace falta
 * `libphonenumber-js` (que esta pensado para desambiguar numeros locales con
 * una region por defecto): aqui no hay ambiguedad que resolver. Se valida
 * contra la misma forma E.164 que exige `inboundMessageSchema` del nucleo,
 * para no construir jamas un InboundMessage que el nucleo rechazaria.
 */
function toE164(from: string): string | undefined {
  const digits = from.replace(/[^0-9]/g, '');
  if (digits.length === 0) return undefined;
  const candidate = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : undefined;
}

function parseTimestamp(raw: string | undefined, fallback: () => Date): Date {
  if (!raw) return fallback();
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return fallback();
  return new Date(seconds * 1000);
}

/** Store compartido entre invocaciones cuando quien compone no inyecta uno propio (ver `WhatsappControllerDeps.dedupeStore`). */
const defaultDedupeStore = new InMemoryDedupeStore();

async function processTextMessage(
  message: WhatsappMessage,
  phoneNumberId: string,
  contactName: string | undefined,
  deps: WhatsappControllerDeps,
): Promise<void> {
  const dedupe = deps.dedupeStore ?? defaultDedupeStore;

  if (dedupe.has(message.id)) {
    deps.logger.debug({}, 'whatsapp webhook: mensaje duplicado (mismo message.id), se ignora');
    return;
  }

  const patientPhoneE164 = toE164(message.from);
  if (!patientPhoneE164) {
    deps.logger.warn({}, 'whatsapp webhook: numero de origen con formato inesperado, se ignora el mensaje');
    return;
  }

  const routing = await deps.resolveRouting(phoneNumberId);
  if (!routing) {
    deps.logger.warn({}, 'whatsapp webhook: phone_number_id sin clinica asociada, se ignora el mensaje');
    return;
  }

  // Marcar ANTES de invocar al nucleo: prioriza nunca duplicar un efecto de
  // negocio (una cita creada dos veces) por sobre el riesgo, mucho menor, de
  // no reprocesar un mensaje si el turno falla a mitad de camino. Meta,
  // ademas, ya recibio su 200 antes de llegar aqui: en operacion normal no
  // va a reintentar este message.id de todos modos.
  dedupe.markSeen(message.id);

  const inbound: InboundMessage = {
    clinicId: routing.clinicId,
    patientPhoneE164,
    patientName: contactName,
    text: message.text?.body ?? '',
    channel: 'whatsapp',
    receivedAt: parseTimestamp(message.timestamp, deps.now ?? (() => new Date())),
  };

  try {
    const outbound = await deps.conversationService.handleTurn(inbound);
    await routing.outboundSender.sendOutbound(patientPhoneE164, outbound);
  } catch (err) {
    deps.logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'whatsapp webhook: fallo procesando el turno o enviando la respuesta',
    );
  }
}

/**
 * Procesa un payload completo de webhook: recorre entries/changes, ignora
 * todo lo que no sea un mensaje de texto (estados de entrega, reacciones,
 * multimedia...) sin fallar, y despacha cada mensaje de texto valido.
 *
 * Exportada por separado de la ruta POST para poder probarla de forma
 * determinista (awaiteable de punta a punta), sin depender de la ambiguedad
 * de cuanto tarda en asentarse el trabajo en segundo plano que arranca la
 * ruta HTTP despues de responder 200.
 */
export async function handleWhatsAppWebhookEvent(rawPayload: unknown, deps: WhatsappControllerDeps): Promise<void> {
  const parsed = whatsappWebhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    deps.logger.warn({}, 'whatsapp webhook: payload con forma inesperada, se ignora');
    return;
  }

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const messages = change.value.messages ?? [];
      if (messages.length === 0) {
        // Solo estados de entrega/otros eventos sin mensaje: nada que traducir.
        continue;
      }

      const phoneNumberId = change.value.metadata.phone_number_id;
      const contactName = change.value.contacts?.[0]?.profile?.name;

      for (const message of messages) {
        if (message.type !== 'text' || message.text === undefined) {
          deps.logger.debug({ tipo: message.type }, 'whatsapp webhook: evento no es mensaje de texto, se ignora');
          continue;
        }
        await processTextMessage(message, phoneNumberId, contactName, deps);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin Fastify
// ---------------------------------------------------------------------------

export const whatsappWebhookPlugin: FastifyPluginAsync<WhatsappControllerDeps> = async (app, deps) => {
  registerRawBodyJsonParser(app);

  // GET: verificacion del webhook contra WHATSAPP_WEBHOOK_SECRET (deps.verifyToken).
  app.get('/', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token !== undefined && token === deps.verifyToken) {
      return reply.status(200).send(challenge ?? '');
    }

    deps.logger.warn({}, 'whatsapp webhook: verificacion rechazada (modo o token invalido)');
    return reply.status(403).send();
  });

  // POST: mensajes entrantes.
  app.post('/', async (request: FastifyRequest, reply) => {
    const rawBody = request.rawBody ?? '';
    const signatureHeaderRaw = request.headers['x-hub-signature-256'];
    const signatureHeader = Array.isArray(signatureHeaderRaw) ? signatureHeaderRaw[0] : signatureHeaderRaw;

    const verification = verifyWhatsappWebhookSignature(rawBody, signatureHeader, deps.appSecret);
    if (!verification.valid) {
      deps.logger.warn({ motivo: verification.reason }, 'whatsapp webhook: firma invalida, se rechaza sin procesar');
      return reply.status(401).send();
    }

    // Responder de inmediato (ver "ACK INMEDIATO" en el comentario de cabecera).
    reply.status(200).send({ received: true });

    void handleWhatsAppWebhookEvent(request.body, deps).catch((err) => {
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'whatsapp webhook: error inesperado procesando el payload tras el ACK',
      );
    });
    return;
  });
};
