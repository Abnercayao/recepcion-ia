/**
 * DEMO CONVERSACIONAL CONTRA LA INFRAESTRUCTURA REAL.
 *
 * Diferencia con `npm run demo`: aquel monta dobles en memoria —persistencia,
 * RAG por coincidencia de palabras, agenda inventada— para poder correr con
 * solo `ANTHROPIC_API_KEY`. Este usa lo de verdad: Supabase, embeddings de
 * Voyage sobre la base aprobada, y Google Calendar.
 *
 * POR QUE ESTO NO NECESITA URL PUBLICA
 * El nucleo conversacional no la necesita: es una funcion de un mensaje a una
 * respuesta. La URL publica la exigen los CANALES, porque ahi es el proveedor
 * —Meta, ElevenLabs— quien tiene que alcanzarnos a nosotros. Invocando
 * `ConversationService.handleTurn` directamente se prueba todo el sistema menos
 * el transporte.
 *
 *   npm run demo:real                     # conversacion de ejemplo
 *   npm run demo:real -- --interactivo    # escribes tu
 *   npm run demo:real -- --canal voice    # con el estilo de voz
 *
 * ESCRIBE EN LA BASE. Crea paciente, conversacion y mensajes reales, y puede
 * crear citas en el calendario si la conversacion llega a eso. Al terminar
 * imprime el id de la conversacion por si quieres borrarla.
 *
 * CUIDADO CON EL LIMITE DE VOYAGE. En el plan gratuito son 3 peticiones por
 * minuto, y cada turno que consulte la base gasta una. Entre turno y turno se
 * espera lo necesario; si aun asi el RAG devuelve vacio, es eso y no el prompt.
 */
import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/infra/config.js';
import { createLogger } from '../src/infra/logger.js';
import { createSupabaseClient } from '../src/infra/supabase.client.js';
import { GoogleCalendarClient } from '../src/infra/calendar.client.js';
import { NotificationClient } from '../src/infra/notification.client.js';
import {
  SupabaseAuditRepository,
  SupabaseClinicRepository,
  SupabaseConversationRepository,
  SupabaseMessageRepository,
  SupabasePatientRepository,
  SupabaseToolCallRepository,
} from '../src/infra/repositories/index.js';

import { ClaudeService } from '../src/core/claude/claude.service.js';
import { GuardrailService } from '../src/core/claude/guardrails.js';
import { PromptBuilder, loadPromptTemplates } from '../src/core/claude/prompt.builder.js';
import { UrgencyDetector } from '../src/core/urgency/urgency.detector.js';
import { VoyageEmbeddingService } from '../src/core/rag/embedding.service.js';
import { SupabaseKnowledgeRepository } from '../src/core/rag/knowledge.repository.js';
import { RagService } from '../src/core/rag/rag.service.js';
import { ToolRegistryImpl } from '../src/core/tools/tool.registry.js';
import { ConsultarAgendaTool } from '../src/core/tools/consultar-agenda.tool.js';
import { CrearCitaTool } from '../src/core/tools/crear-cita.tool.js';
import { ConsultarRagTool } from '../src/core/tools/consultar-rag.tool.js';
import { GuardarLeadTool } from '../src/core/tools/guardar-lead.tool.js';
import { EscalarHumanoTool } from '../src/core/tools/escalar-humano.tool.js';
import { MessageRouter } from '../src/core/conversation/message.router.js';
import { ConversationServiceImpl } from '../src/core/conversation/conversation.service.js';
import type { Channel } from '../src/core/types/channel.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIRECTORIO_DE_PROMPTS = resolve(join(AQUI, '..', 'prompts'));

/** Margen entre turnos para no chocar con el limite de 3 RPM de Voyage. */
const ESPERA_ENTRE_TURNOS_MS = 21_000;

const GUION = [
  '¿cuánto cuesta una limpieza dental?',
  '¿tienen espacio esta semana por la mañana?',
  'me duele mucho una muela desde anoche, ¿qué me tomo?',
];

async function main(): Promise<void> {
  const argumentos = process.argv.slice(2);
  const interactivo = argumentos.includes('--interactivo');
  const indiceCanal = argumentos.indexOf('--canal');
  const canal: Channel = argumentos[indiceCanal + 1] === 'voice' ? 'voice' : 'whatsapp';
  const clinicId = process.env['CLINIC_ID'] ?? '00000000-0000-4000-8000-000000000001';

  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: 'error' as const });
  const supabase = createSupabaseClient(config);

  const clinics = new SupabaseClinicRepository(supabase);
  const patients = new SupabasePatientRepository(supabase);
  const conversations = new SupabaseConversationRepository(supabase);
  const messages = new SupabaseMessageRepository(supabase);
  const toolCalls = new SupabaseToolCallRepository(supabase);
  const audit = new SupabaseAuditRepository(supabase);

  const clinica = await clinics.findById(clinicId);
  if (!clinica) {
    process.stdout.write(`No existe la clinica ${clinicId}. ¿Ejecutaste \`npm run db:seed\`?\n`);
    process.exitCode = 1;
    return;
  }

  const calendar = new GoogleCalendarClient(clinics, config, logger);
  const notifications = new NotificationClient({
    ...(config.N8N_WEBHOOK_URL ? { webhookUrl: config.N8N_WEBHOOK_URL } : {}),
    logger,
  });
  const rag = new RagService(
    new VoyageEmbeddingService({
      ...(config.VOYAGE_API_KEY ? { apiKey: config.VOYAGE_API_KEY } : {}),
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
    }),
    new SupabaseKnowledgeRepository(supabase),
    logger,
    { umbralSimilitud: config.RAG_UMBRAL_SIMILITUD },
  );
  const claude = new ClaudeService({
    config: {
      apiKey: config.ANTHROPIC_API_KEY,
      modelPorDefecto: config.CLAUDE_MODEL_CONVERSACION,
      maxTokens: config.CLAUDE_MAX_TOKENS,
      temperature: config.CLAUDE_TEMPERATURE,
    },
    logger,
  });

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
    { ventanaContinuidadHoras: config.VENTANA_CONTINUIDAD_HORAS, regionPorDefecto: config.DEFAULT_PHONE_REGION },
  );
  const conversacion = new ConversationServiceImpl(
    { router, claude, promptBuilder, rag, urgency, guardrails, tools, messages, logger, audit },
    { model: config.CLAUDE_MODEL_CONVERSACION, maxTokens: config.CLAUDE_MAX_TOKENS },
  );

  const telefono = process.env['DEMO_TELEFONO'] ?? '+51999000123';
  process.stdout.write(
    `DEMO · ${clinica.nombre}\n` +
      `  canal: ${canal}  ·  paciente: ${telefono}  ·  infraestructura REAL\n` +
      `  umbral RAG: ${config.RAG_UMBRAL_SIMILITUD}  ·  modelo: ${config.CLAUDE_MODEL_CONVERSACION}\n\n`,
  );

  const turno = async (texto: string, primero: boolean): Promise<void> => {
    if (!primero) await new Promise((r) => setTimeout(r, ESPERA_ENTRE_TURNOS_MS));
    process.stdout.write(`\x1b[1mPACIENTE\x1b[0m  ${texto}\n`);
    const empezado = Date.now();
    const salida = await conversacion.handleTurn({
      clinicId,
      patientPhoneE164: telefono,
      text: texto,
      channel: canal,
      receivedAt: new Date(),
    });
    process.stdout.write(`\x1b[36mAGENTE\x1b[0m    ${salida.text}\n`);

    // Las herramientas que se ejecutaron se leen de `tool_calls`, que es donde
    // el registro las deja: `OutboundMessage` solo lleva el texto y el
    // escalamiento, a proposito — el canal no necesita saber mas.
    const { data: llamadas } = await supabase
      .from('tool_calls')
      .select('herramienta,estado')
      .eq('conversation_id', salida.conversationId)
      .order('creado_en', { ascending: false })
      .limit(6);
    const usadas = ((llamadas ?? []) as Array<{ herramienta: string; estado: string }>)
      .map((t) => `${t.herramienta}(${t.estado})`)
      .join(', ');

    process.stdout.write(
      `          ${Date.now() - empezado} ms` +
        (usadas ? ` · ${usadas}` : '') +
        (salida.escalate ? ` · \x1b[33mESCALADO: ${salida.escalate.reason}\x1b[0m` : '') +
        '\n\n',
    );
  };

  if (interactivo) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Escribe como si fueras el paciente. Línea vacía para salir.\n\n');
    let primero = true;
    for (;;) {
      const texto = (await rl.question('> ')).trim();
      if (!texto) break;
      await turno(texto, primero);
      primero = false;
    }
    rl.close();
  } else {
    for (const [i, texto] of GUION.entries()) await turno(texto, i === 0);
  }

  process.stdout.write('Los mensajes quedaron guardados en la base.\n');
}

await main();
