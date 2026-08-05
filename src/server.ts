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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import 'dotenv/config';

import { loadConfig, type Config } from './infra/config.js';
import { createLogger } from './infra/logger.js';
import { RecolectorDeTrazaEnMemoria } from './infra/traza.memoria.js';
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
import { postCallWebhookPlugin } from './channels/voice/post-call.controller.js';
import { conversationInitiationPlugin } from './channels/voice/conversation-initiation.controller.js';
import { webhookToolsPlugin } from './channels/voice/webhook-tools.controller.js';
import { VoiceSessionService } from './channels/voice/voice-session.service.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** En desarrollo se ejecuta desde `src/`; compilado, desde `dist/`. `prompts/` esta en la raiz. */
const DIRECTORIO_DE_PROMPTS = join(AQUI, '..', 'prompts');

export async function construirServidor(config: Config) {
  const logger = createLogger(config);

  /**
   * Traza de diagnostico del proceso.
   *
   * Se monta aqui, en la raiz de composicion, y se inyecta en el nucleo y en
   * los dos webhooks de voz. No sustituye a la auditoria --esa va a
   * `audit_log`, `tool_calls` y `messages`, con retencion--: esto se pierde al
   * reiniciar a proposito. Es un instrumento para mirar en vivo, no un
   * registro.
   */
  const trazas = new RecolectorDeTrazaEnMemoria();

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
    { router, claude, promptBuilder, rag, urgency, guardrails, tools, messages, logger, audit, traza: trazas },
    {
      model: config.CLAUDE_MODEL_CONVERSACION,
      maxTokens: config.CLAUDE_MAX_TOKENS,
      ...(config.CLAUDE_MODEL_VOZ ? { modelVoz: config.CLAUDE_MODEL_VOZ } : {}),
      ...(config.CLAUDE_MAX_TOKENS_VOZ ? { maxTokensVoz: config.CLAUDE_MAX_TOKENS_VOZ } : {}),
    },
  );

  // --- Servidor -----------------------------------------------------------
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  app.get('/health', async () => ({
    estado: 'ok',
    canales: { whatsapp: config.WHATSAPP_ENABLED, voz: config.VOICE_ENABLED },
  }));

  /**
   * Trazas de este proceso, para el panel de diagnostico de la web.
   *
   * PROTEGIDO por `VOICE_GATEWAY_SECRET` y con el secreto en la RUTA, igual que
   * los webhooks de voz. No es opcional: este proceso se publica por un tunel,
   * y las trazas llevan lo que dijo el paciente y con que argumentos se llamo a
   * las herramientas. Aunque todo pasa por `maskPII`, seguir dejandolo abierto
   * seria publicar conversaciones clinicas en internet.
   *
   * Sin secreto configurado NO se registra la ruta: preferimos que el panel
   * diga "no hay trazas de voz" a exponerlas por olvido.
   */
  const secretoDeTrazas = config.VOICE_GATEWAY_SECRET ?? '';
  if (secretoDeTrazas !== '') {
    app.get('/v1/g/:secret/trazas', async (peticion, respuesta) => {
      const { secret } = peticion.params as { secret: string };
      // Comparacion en tiempo constante, como en el resto de la frontera.
      let diferencia = secret.length ^ secretoDeTrazas.length;
      for (let i = 0; i < secret.length && i < secretoDeTrazas.length; i += 1) {
        diferencia |= secret.charCodeAt(i) ^ secretoDeTrazas.charCodeAt(i);
      }
      if (diferencia !== 0) return respuesta.code(401).send({ error: 'no autorizado' });

      return { total: trazas.total, trazas: trazas.listar(40) };
    });
  } else {
    logger.warn(
      { componente: 'trazas' },
      'sin VOICE_GATEWAY_SECRET no se expone /trazas: el panel de la web no vera el canal de voz',
    );
  }

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
    const calls = new SupabaseCallRepository(supabase);
    const transcripts = new SupabaseTranscriptRepository(supabase);

    const sessions = new VoiceSessionService({ calls, transcripts, logger });

    await app.register(voiceGatewayPlugin, {
      conversationService,
      clinics,
      sessions,
      logger,
      gatewaySecret: config.VOICE_GATEWAY_SECRET ?? '',
      bufferWordMs: config.VOICE_BUFFER_WORD_MS,
    });

    // Webhook de iniciacion: lo llama ElevenLabs al entrar la llamada y de su
    // respuesta salen `clinic_id`, `session_id` y el telefono. Sin el, el
    // gateway no resuelve contexto y deriva a una persona en cada llamada.
    const clinicIdVoz = process.env['CLINIC_ID'] ?? process.env['VOICE_CLINIC_ID'];
    if (!clinicIdVoz) {
      throw new Error(
        'VOICE_ENABLED=true requiere CLINIC_ID: sin el, el webhook de iniciacion no sabe a que clinica pertenece una llamada entrante.',
      );
    }
    const clinicaDeVoz = await clinics.findById(clinicIdVoz);
    if (!clinicaDeVoz) {
      throw new Error(`CLINIC_ID=${clinicIdVoz} no existe en la tabla clinics.`);
    }

    // Las cinco herramientas como webhooks, para un agente que razona con un
    // modelo ALOJADO por el proveedor. Ver la cabecera de ese archivo: en ese
    // modo NO hay capa 2, y lo que queda es que el modelo no pueda HACER lo
    // que quiera aunque pueda DECIR lo que quiera.
    await app.register(webhookToolsPlugin, {
      router,
      tools,
      clinics,
      audit,
      logger,
      gatewaySecret: config.VOICE_GATEWAY_SECRET ?? '',
      traza: trazas,
      /**
       * Confirmacion de la cita al paciente.
       *
       * El agente cierra la llamada prometiendo los detalles por WhatsApp. Ese
       * envio NO lo hace este sistema: `WHATSAPP_ENABLED` esta en false y las
       * credenciales de Meta estan vacias. Lo que se hace aqui es ENTREGAR los
       * datos a n8n, que es donde la clinica ya recibe los escalamientos, para
       * que el flujo correspondiente los mande.
       *
       * Mientras ese flujo no exista, la promesa del agente no se cumple. Queda
       * dicho en `docs/CONTINUAR.md` y avisado por el log en cada cita.
       */
      ...(config.N8N_WEBHOOK_URL
        ? {
            avisarCitaCreada: async (aviso): Promise<void> => {
              const respuesta = await fetch(config.N8N_WEBHOOK_URL as string, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tipo: 'cita_creada', ...aviso }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!respuesta.ok) {
                throw new Error(`n8n respondio ${String(respuesta.status)}`);
              }
              logger.info(
                { conversationId: aviso.conversationId, sede: aviso.sede },
                'cita entregada a n8n para la confirmacion al paciente',
              );
            },
          }
        : {}),
    });

    await app.register(conversationInitiationPlugin, {
      router,
      calls,
      audit,
      logger,
      gatewaySecret: config.VOICE_GATEWAY_SECRET ?? '',
      clinicId: clinicIdVoz,
      clinica: clinicaDeVoz,
      traza: trazas,
      ...(config.SIP_PROVIDER ? { proveedorSip: config.SIP_PROVIDER } : {}),
    });

    // Webhook post-llamada. Secreto DISTINTO del del gateway (contrato §2 vs §7):
    // ELEVENLABS_WEBHOOK_SECRET es con el que el proveedor FIRMA el webhook.
    await app.register(postCallWebhookPlugin, {
      calls,
      transcripts,
      audit,
      logger,
      webhookSecret: config.ELEVENLABS_WEBHOOK_SECRET ?? '',
      retencionAudioDias: config.RETENCION_AUDIO_DIAS,
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
//
// La comparacion la hace `pathToFileURL` y no una plantilla a mano. Construir
// `file://${ruta}` falla en dos casos que aqui se dan a la vez: en Windows la
// URL lleva TRES barras antes de la letra de unidad (`file:///C:/...`), y
// cualquier ruta con espacios llega percent-encoded (`IA%20GENERATIVA`). Con la
// plantilla, la igualdad era falsa siempre, `main()` no se llamaba y el proceso
// terminaba en silencio: `npm run dev` y `npm start` no levantaban nada y no
// imprimian ningun error.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
