/**
 * Raiz de composicion y arranque del servidor.
 *
 * Este es el UNICO archivo donde el nucleo se encuentra con la infraestructura
 * concreta. `core/` depende solo de los puertos de `core/types/ports.ts`; aqui
 * se eligen las implementaciones y se inyectan por constructor. Es lo que hace
 * que sustituir Supabase, Google Calendar o el proveedor de embeddings sea
 * configuracion y no reescritura.
 *
 * Los dos canales comparten el MISMO `ConversationService`. Si algun dia hay
 * que construir dos, el diseno se rompio.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import 'dotenv/config';

import { loadConfig, type Config } from './infra/config.js';
import { createLogger } from './infra/logger.js';
import { createSupabaseClient } from './infra/supabase.client.js';
import { GoogleCalendarClient } from './infra/calendar.client.js';
import { NotificationClient } from './infra/notification.client.js';
import {
  SupabaseAuditRepository,
  SupabaseCallRepository,
  SupabaseClinicRepository,
  SupabaseConversationRepository,
  SupabaseMessageRepository,
  SupabasePatientRepository,
  SupabaseToolCallRepository,
  SupabaseTranscriptRepository,
} from './infra/repositories/index.js';

import { ClaudeService } from './core/claude/claude.service.js';
import { GuardrailService } from './core/claude/guardrails.js';
import { PromptBuilder, loadPromptTemplates } from './core/claude/prompt.builder.js';
import { UrgencyDetector } from './core/urgency/urgency.detector.js';
import { VoyageEmbeddingService } from './core/rag/embedding.service.js';
import { SupabaseKnowledgeRepository } from './core/rag/knowledge.repository.js';
import { RagService } from './core/rag/rag.service.js';
import { ToolRegistryImpl } from './core/tools/tool.registry.js';
import { ConsultarAgendaTool } from './core/tools/consultar-agenda.tool.js';
import { CrearCitaTool } from './core/tools/crear-cita.tool.js';
import { ConsultarRagTool } from './core/tools/consultar-rag.tool.js';
import { GuardarLeadTool } from './core/tools/guardar-lead.tool.js';
import { EscalarHumanoTool } from './core/tools/escalar-humano.tool.js';
import { MessageRouter } from './core/conversation/message.router.js';
import { ConversationServiceImpl } from './core/conversation/conversation.service.js';

import { whatsappWebhookPlugin } from './channels/whatsapp/whatsapp.controller.js';
import { WhatsappAdapter } from './channels/whatsapp/whatsapp.adapter.js';
import type { WhatsappClinicRouting } from './channels/whatsapp/whatsapp.types.js';
import { voiceGatewayPlugin } from './channels/voice/voice-gateway.controller.js';
import { VoiceSessionService } from './channels/voice/voice-session.service.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** En desarrollo se ejecuta desde `src/`; compilado, desde `dist/`. `prompts/` esta en la raiz. */
const DIRECTORIO_DE_PROMPTS = join(AQUI, '..', 'prompts');

export async function construirServidor(config: Config) {
  const logger = createLogger(config);

  // --- Persistencia -------------------------------------------------------
  const supabase = createSupabaseClient(config);
  const clinics = new SupabaseClinicRepository(supabase);
  const patients = new SupabasePatientRepository(supabase);
  const conversations = new SupabaseConversationRepository(supabase);
  const messages = new SupabaseMessageRepository(supabase);
  const toolCalls = new SupabaseToolCallRepository(supabase);
  const audit = new SupabaseAuditRepository(supabase);

  // --- Integraciones ------------------------------------------------------
  // El cliente parsea las credenciales el mismo, y de forma perezosa: recibe la
  // config, no un objeto ya parseado.
  const calendar = new GoogleCalendarClient(clinics, config, logger);

  const notifications = new NotificationClient({
    ...(config.N8N_WEBHOOK_URL ? { webhookUrl: config.N8N_WEBHOOK_URL } : {}),
    logger,
  });

  // --- Conocimiento -------------------------------------------------------
  const embeddings = new VoyageEmbeddingService({
    ...(config.VOYAGE_API_KEY ? { apiKey: config.VOYAGE_API_KEY } : {}),
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
  });
  const rag = new RagService(embeddings, new SupabaseKnowledgeRepository(supabase), logger);

  // --- Modelo -------------------------------------------------------------
  const claude = new ClaudeService({
    config: {
      apiKey: config.ANTHROPIC_API_KEY,
      modelPorDefecto: config.CLAUDE_MODEL_CONVERSACION,
      maxTokens: config.CLAUDE_MAX_TOKENS,
      temperature: config.CLAUDE_TEMPERATURE,
    },
    logger,
  });

  // --- Nucleo -------------------------------------------------------------
  const promptBuilder = new PromptBuilder(await loadPromptTemplates(DIRECTORIO_DE_PROMPTS));
  const guardrails = new GuardrailService({ logger, audit });

  const urgency = new UrgencyDetector({
    claude,
    logger,
    prompt: promptBuilder.promptDeUrgencia,
    model: config.CLAUDE_MODEL_CLASIFICACION,
  });

  const tools = new ToolRegistryImpl(
    [
      new ConsultarAgendaTool(calendar, toolCalls, logger),
      new CrearCitaTool(calendar, toolCalls, logger),
      new ConsultarRagTool(rag, toolCalls, logger),
      new GuardarLeadTool(audit, toolCalls, logger),
      new EscalarHumanoTool(notifications, conversations, toolCalls, logger),
    ],
    toolCalls,
    logger,
  );

  const router = new MessageRouter(
    { clinics, patients, conversations, messages, logger },
    {
      ventanaContinuidadHoras: config.VENTANA_CONTINUIDAD_HORAS,
      regionPorDefecto: config.DEFAULT_PHONE_REGION,
    },
  );

  // UN solo servicio de conversacion para los dos canales.
  const conversationService = new ConversationServiceImpl(
    { router, claude, promptBuilder, rag, urgency, guardrails, tools, messages, logger, audit },
    { model: config.CLAUDE_MODEL_CONVERSACION, maxTokens: config.CLAUDE_MAX_TOKENS },
  );

  // --- Servidor -----------------------------------------------------------
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  app.get('/health', async () => ({
    estado: 'ok',
    canales: { whatsapp: config.WHATSAPP_ENABLED, voz: config.VOICE_ENABLED },
  }));

  if (config.WHATSAPP_ENABLED) {
    // Un `phone_number_id` de Meta corresponde a una clinica. Con varias
    // clinicas, aqui se resuelve cada una a su adaptador; hoy hay una sola,
    // definida por el entorno.
    const adapter = new WhatsappAdapter({
      phoneNumberId: config.WHATSAPP_PHONE_ID ?? '',
      bspToken: config.WHATSAPP_BSP_TOKEN ?? '',
      clinicName: process.env['CLINIC_NAME'] ?? 'la clinica',
      logger,
    });

    const clinicId = process.env['CLINIC_ID'];
    if (!clinicId) {
      throw new Error(
        'WHATSAPP_ENABLED=true requiere CLINIC_ID: sin el no se sabe a que clinica pertenece un mensaje entrante.',
      );
    }

    await app.register(whatsappWebhookPlugin, {
      conversationService,
      logger,
      verifyToken: config.WHATSAPP_WEBHOOK_SECRET ?? '',
      // App Secret de Meta: credencial DISTINTA del token del challenge GET.
      appSecret: config.WHATSAPP_APP_SECRET ?? '',
      resolveRouting: async (phoneNumberId): Promise<WhatsappClinicRouting | undefined> =>
        phoneNumberId === config.WHATSAPP_PHONE_ID
          ? { clinicId, outboundSender: adapter }
          : undefined,
    });
  }

  if (config.VOICE_ENABLED) {
    const sessions = new VoiceSessionService({
      calls: new SupabaseCallRepository(supabase),
      transcripts: new SupabaseTranscriptRepository(supabase),
      logger,
    });

    await app.register(voiceGatewayPlugin, {
      conversationService,
      clinics,
      sessions,
      logger,
      gatewaySecret: config.VOICE_GATEWAY_SECRET ?? '',
      bufferWordMs: config.VOICE_BUFFER_WORD_MS,
    });
  }

  return { app, logger };
}

async function main(): Promise<void> {
  // Si el entorno esta incompleto, esto lanza y el proceso NO arranca.
  // Es deliberado: un sistema de salud a medias es peor que uno caido.
  const config = loadConfig();
  const { app, logger } = await construirServidor(config);

  const cerrar = async (senal: string): Promise<void> => {
    logger.info({ senal }, 'cerrando el servidor');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void cerrar('SIGTERM'));
  process.on('SIGINT', () => void cerrar('SIGINT'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    {
      puerto: config.PORT,
      whatsapp: config.WHATSAPP_ENABLED,
      voz: config.VOICE_ENABLED,
      modeloConversacion: config.CLAUDE_MODEL_CONVERSACION,
      modeloClasificacion: config.CLAUDE_MODEL_CLASIFICACION,
    },
    'Recepcion-IA en marcha',
  );
}

// Solo arranca si se ejecuta directamente; importarlo desde un test no levanta nada.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
