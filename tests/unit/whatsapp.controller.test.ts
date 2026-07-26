/**
 * Tests de src/channels/whatsapp/whatsapp.controller.ts.
 *
 * Cubre exactamente lo que pide el Encargo 4 para este archivo:
 *  - firma X-Hub-Signature-256 invalida se rechaza (401), sin llamar al nucleo;
 *  - firma valida se acepta (200 inmediato);
 *  - un evento que no es mensaje de texto (imagen, reaccion, solo estados de
 *    entrega) se ignora sin lanzar y sin llamar al nucleo;
 *  - un mensaje duplicado por `message.id` se procesa una sola vez.
 *
 * Los dos ultimos casos se prueban invocando `handleWhatsAppWebhookEvent`
 * directamente (no via HTTP): es la pieza de traduccion/orquestacion en si,
 * y probarla asi evita cualquier ambiguedad sobre cuanto tarda en asentarse
 * el procesamiento en segundo plano que la ruta POST dispara DESPUES de
 * responder 200 (ver comentario de cabecera de whatsapp.controller.ts).
 *
 * No hay credenciales de Meta: nada de esto toca la red. `conversationService`
 * y el `outboundSender` son dobles en memoria.
 */
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  handleWhatsAppWebhookEvent,
  verifyWhatsappWebhookSignature,
  whatsappWebhookPlugin,
  type WhatsappControllerDeps,
} from '../../src/channels/whatsapp/whatsapp.controller.js';
import { InMemoryDedupeStore, type WhatsappClinicRouting } from '../../src/channels/whatsapp/whatsapp.types.js';
import type { ConversationService, Logger, OutboundMessage } from '../../src/core/types/index.js';

const APP_SECRET = 'secreto-de-la-app-de-meta';
const VERIFY_TOKEN = 'token-de-verificacion-del-webhook';
const CLINIC_ID = '11111111-1111-4111-8111-111111111111';

function fakeLogger(): Logger {
  const self: Logger = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => self),
  };
  return self;
}

function fakeConversationService(outbound?: Partial<OutboundMessage>): ConversationService {
  const respuesta: OutboundMessage = {
    conversationId: 'conv-1',
    text: 'Respuesta del nucleo.',
    channel: 'whatsapp',
    latencyMs: 10,
    ...outbound,
  };
  return {
    handleTurn: vi.fn(async () => respuesta),
    streamTurn: vi.fn(async function* () {
      yield { type: 'done' as const, message: respuesta };
    }),
  };
}

function firmar(rawBody: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

function buildDeps(overrides: Partial<WhatsappControllerDeps> = {}): {
  deps: WhatsappControllerDeps;
  conversationService: ConversationService;
  outboundSender: { sendOutbound: ReturnType<typeof vi.fn> };
} {
  const conversationService = fakeConversationService();
  const outboundSender = { sendOutbound: vi.fn(async () => undefined) };
  const routing: WhatsappClinicRouting = { clinicId: CLINIC_ID, outboundSender };

  const deps: WhatsappControllerDeps = {
    conversationService,
    logger: fakeLogger(),
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    resolveRouting: vi.fn(async () => routing),
    dedupeStore: new InMemoryDedupeStore(),
    now: () => new Date('2026-07-25T12:00:00Z'),
    ...overrides,
  };

  return { deps, conversationService, outboundSender };
}

function textMessagePayload(overrides: { messageId?: string; from?: string; body?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'phone-numero-1' },
              contacts: [{ profile: { name: 'Rosa Quispe' }, wa_id: '51987654321' }],
              messages: [
                {
                  from: overrides.from ?? '51987654321',
                  id: overrides.messageId ?? 'wamid.UNICO-1',
                  timestamp: '1780000000',
                  type: 'text',
                  text: { body: overrides.body ?? 'Hola, quisiera una cita' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Firma X-Hub-Signature-256
// ---------------------------------------------------------------------------

describe('verifyWhatsappWebhookSignature', () => {
  it('acepta una firma calculada correctamente sobre el cuerpo crudo', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const result = verifyWhatsappWebhookSignature(rawBody, firmar(rawBody), APP_SECRET);
    expect(result.valid).toBe(true);
  });

  it('rechaza si el secreto no coincide', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const result = verifyWhatsappWebhookSignature(rawBody, firmar(rawBody, 'otro-secreto'), APP_SECRET);
    expect(result.valid).toBe(false);
  });

  it('rechaza si el cuerpo fue alterado despues de firmarlo', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const firma = firmar(rawBody);
    const result = verifyWhatsappWebhookSignature(JSON.stringify({ a: 2 }), firma, APP_SECRET);
    expect(result.valid).toBe(false);
  });

  it('rechaza si falta el header', () => {
    const result = verifyWhatsappWebhookSignature('{}', undefined, APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/falta/);
  });

  it('rechaza un header con formato invalido (sin prefijo sha256=)', () => {
    const result = verifyWhatsappWebhookSignature('{}', 'abcd1234', APP_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/formato/);
  });
});

// ---------------------------------------------------------------------------
// Ruta HTTP: aceptacion/rechazo por firma
// ---------------------------------------------------------------------------

describe('whatsappWebhookPlugin - POST / (verificacion de firma)', () => {
  it('firma invalida se rechaza con 401 y NO llama al nucleo', async () => {
    const { deps, conversationService } = buildDeps();
    const app = Fastify();
    await app.register(whatsappWebhookPlugin, deps);
    await app.ready();

    const payload = textMessagePayload();
    const rawBody = JSON.stringify(payload);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=firma-invalida' },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
    expect(conversationService.handleTurn).not.toHaveBeenCalled();

    await app.close();
  });

  it('firma valida se acepta con 200 de inmediato', async () => {
    const { deps } = buildDeps();
    const app = Fastify();
    await app.register(whatsappWebhookPlugin, deps);
    await app.ready();

    const payload = textMessagePayload();
    const rawBody = JSON.stringify(payload);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(rawBody) },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('sin header de firma se rechaza con 401', async () => {
    const { deps } = buildDeps();
    const app = Fastify();
    await app.register(whatsappWebhookPlugin, deps);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(textMessagePayload()),
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Ruta HTTP: verificacion GET del webhook
// ---------------------------------------------------------------------------

describe('whatsappWebhookPlugin - GET / (verificacion del webhook)', () => {
  it('responde el challenge cuando el modo y el token son correctos', async () => {
    const { deps } = buildDeps();
    const app = Fastify();
    await app.register(whatsappWebhookPlugin, deps);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1234567');

    await app.close();
  });

  it('rechaza con 403 cuando el token de verificacion no coincide', async () => {
    const { deps } = buildDeps();
    const app = Fastify();
    await app.register(whatsappWebhookPlugin, deps);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/?hub.mode=subscribe&hub.verify_token=token-incorrecto&hub.challenge=1234567',
    });

    expect(response.statusCode).toBe(403);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// handleWhatsAppWebhookEvent: traduccion, filtrado de no-texto, dedupe
// ---------------------------------------------------------------------------

describe('handleWhatsAppWebhookEvent - filtra eventos que no son mensajes de texto', () => {
  it('ignora un mensaje de imagen sin lanzar y sin llamar al nucleo', async () => {
    const { deps, conversationService, outboundSender } = buildDeps();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-numero-1' },
                messages: [{ from: '51987654321', id: 'wamid.IMG-1', type: 'image', image: { id: 'media-1' } }],
              },
            },
          ],
        },
      ],
    };

    await expect(handleWhatsAppWebhookEvent(payload, deps)).resolves.toBeUndefined();
    expect(conversationService.handleTurn).not.toHaveBeenCalled();
    expect(outboundSender.sendOutbound).not.toHaveBeenCalled();
  });

  it('ignora una reaccion sin lanzar y sin llamar al nucleo', async () => {
    const { deps, conversationService } = buildDeps();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-numero-1' },
                messages: [
                  { from: '51987654321', id: 'wamid.REACT-1', type: 'reaction', reaction: { emoji: '👍' } },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(handleWhatsAppWebhookEvent(payload, deps)).resolves.toBeUndefined();
    expect(conversationService.handleTurn).not.toHaveBeenCalled();
  });

  it('ignora una notificacion de solo estados de entrega (sin array messages) sin lanzar', async () => {
    const { deps, conversationService } = buildDeps();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-numero-1' },
                statuses: [{ id: 'wamid.X', status: 'delivered', recipient_id: '51987654321' }],
              },
            },
          ],
        },
      ],
    };

    await expect(handleWhatsAppWebhookEvent(payload, deps)).resolves.toBeUndefined();
    expect(conversationService.handleTurn).not.toHaveBeenCalled();
  });

  it('ignora un payload con forma completamente inesperada sin lanzar', async () => {
    const { deps, conversationService } = buildDeps();
    await expect(handleWhatsAppWebhookEvent({ esto: 'no es un webhook de whatsapp' }, deps)).resolves.toBeUndefined();
    expect(conversationService.handleTurn).not.toHaveBeenCalled();
  });
});

describe('handleWhatsAppWebhookEvent - traduce un mensaje de texto valido', () => {
  it('llama a conversationService.handleTurn con un InboundMessage correcto y envia la respuesta', async () => {
    const { deps, conversationService, outboundSender } = buildDeps();
    const payload = textMessagePayload({ body: 'Quisiera agendar una cita' });

    await handleWhatsAppWebhookEvent(payload, deps);

    expect(conversationService.handleTurn).toHaveBeenCalledTimes(1);
    const inbound = (conversationService.handleTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inbound).toMatchObject({
      clinicId: CLINIC_ID,
      patientPhoneE164: '+51987654321',
      patientName: 'Rosa Quispe',
      text: 'Quisiera agendar una cita',
      channel: 'whatsapp',
    });
    expect(inbound.receivedAt).toBeInstanceOf(Date);

    expect(outboundSender.sendOutbound).toHaveBeenCalledTimes(1);
    expect(outboundSender.sendOutbound).toHaveBeenCalledWith('+51987654321', expect.objectContaining({ conversationId: 'conv-1' }));
  });

  it('ignora el mensaje si resolveRouting no encuentra clinica para el phone_number_id', async () => {
    const { deps, conversationService } = buildDeps({ resolveRouting: vi.fn(async () => undefined) });
    await expect(handleWhatsAppWebhookEvent(textMessagePayload(), deps)).resolves.toBeUndefined();
    expect(conversationService.handleTurn).not.toHaveBeenCalled();
  });
});

describe('handleWhatsAppWebhookEvent - deduplicacion por message.id', () => {
  it('un mensaje con el mismo message.id se procesa una sola vez', async () => {
    const { deps, conversationService } = buildDeps();
    const payload = textMessagePayload({ messageId: 'wamid.REPETIDO-1' });

    await handleWhatsAppWebhookEvent(payload, deps);
    await handleWhatsAppWebhookEvent(payload, deps); // simula el reintento de Meta con el mismo payload

    expect(conversationService.handleTurn).toHaveBeenCalledTimes(1);
  });

  it('dos message.id distintos SI se procesan por separado', async () => {
    const { deps, conversationService } = buildDeps();

    await handleWhatsAppWebhookEvent(textMessagePayload({ messageId: 'wamid.A' }), deps);
    await handleWhatsAppWebhookEvent(textMessagePayload({ messageId: 'wamid.B' }), deps);

    expect(conversationService.handleTurn).toHaveBeenCalledTimes(2);
  });
});
