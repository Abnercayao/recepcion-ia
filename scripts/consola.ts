/**
 * CONSOLA DE INSPECCION: hablar con el agente y ver POR QUE responde lo que
 * responde.
 *
 *   npm run consola                  # infraestructura real, solo esta maquina
 *   npm run consola -- --red         # accesible desde el movil, misma wifi
 *   npm run consola -- --dobles      # sin gastar nada, sin escribir en la base
 *
 * POR QUE EXISTE
 * Los dos canales estan bloqueados por la misma razon: hacen falta una URL
 * publica HTTPS para que Meta o ElevenLabs nos alcancen. Sin eso no hay forma
 * de escribirle al agente y leer su respuesta.
 *
 * Y leer la respuesta no basta. La tesis del sistema son TRES CAPAS de control,
 * y una respuesta que suena bien puede ser capa 2 sustituyendo lo que el modelo
 * dijo de verdad. Por eso esto no es un chat: cada turno enseña las banderas de
 * capa 1, el veredicto de capa 3, los fragmentos del RAG con su similitud, las
 * intervenciones de capa 2 y las herramientas que corrieron.
 *
 * ESTO NO ES UN TERCER CANAL, y no debe llegar a serlo.
 * `Channel` son exactamente dos valores por doctrina (`core/types/channel.ts`):
 * el canal es un atributo del mensaje, no una propiedad del sistema. La consola
 * IMPERSONA uno de los dos —de ahi el interruptor whatsapp/voz, que enseña el
 * mismo nucleo respondiendo distinto— y por eso vive en `scripts/` y no en
 * `src/`: el servidor de produccion sera publicamente alcanzable en cuanto
 * entre cualquiera de los dos canales, y un endpoint de chat que gasta dinero
 * de la cuenta y escribe en la base no puede compartir esa superficie.
 *
 * NO TOCA UNA LINEA DE `src/`. La visibilidad sale de DECORAR LOS PUERTOS en
 * esta raiz de composicion, que es justo para lo que sirve una raiz de
 * composicion. El nucleo no se entera.
 *
 * EN MODO REAL GASTA Y ESCRIBE: llamadas a Anthropic y a Voyage que se cobran,
 * y filas reales de paciente, conversacion y mensajes en Supabase. Puede crear
 * eventos en Google Calendar.
 */
import 'dotenv/config';

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

import Fastify from 'fastify';

import { loadConfig } from '../src/infra/config.js';
import { esEntradaPrincipal } from '../src/infra/entrada-principal.js';
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
import {
  GuardrailService,
  detectInboundFlags,
  type OutboundEvidence,
} from '../src/core/claude/guardrails.js';
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
import { formatOutboundMessage } from '../src/channels/whatsapp/whatsapp.formatter.js';
import type {
  Channel,
  Clinic,
  EmbeddingPort,
  GuardrailResult,
  KnowledgeChunk,
  Logger,
  RagPort,
  TurnContext,
} from '../src/core/types/index.js';
import { crearDobles } from '../tests/helpers/dobles.js';
import { RagDeDemostracion } from './rag-demostracion.js';

const RAIZ = resolve(import.meta.dirname, '..');

export type Modo = 'real' | 'dobles';

// ---------------------------------------------------------------------------
// Lo que se observa de un turno
// ---------------------------------------------------------------------------

export interface ConsultaRag {
  consulta: string;
  fragmentos: Array<{ id: string; fuente: string; similitud: number | undefined; contenido: string }>;
  /** Por que vino vacio, si vino vacio. Distingue el 429 de «nada relevante». */
  motivoVacio?: string;
}

export interface IntervencionCapa2 {
  motivo: string;
  sustituto: string | undefined;
  /**
   * Lo que el modelo dijo DE VERDAD y el paciente nunca vio.
   *
   * Es el dato central de todo este panel: cuando capa 2 sustituye, la
   * respuesta de fuera parece impecable precisamente porque no es la del
   * modelo. Sin esto no se puede distinguir «el control salvo la situacion» de
   * «el control se disparo de mas y devolvio algo que no viene a cuento».
   */
  textoDelModelo: string;
}

/** Todo lo que las capas hicieron durante UN turno. */
export class RegistroDelTurno {
  consultasRag: ConsultaRag[] = [];
  capa2: IntervencionCapa2[] = [];
  /** Mensaje del fallo de embeddings, si lo hubo. Lo rellena el espia. */
  falloDeEmbeddings: string | undefined;

  reiniciar(): void {
    this.consultasRag = [];
    this.capa2 = [];
    this.falloDeEmbeddings = undefined;
  }
}

/**
 * Traduce el fallo del proveedor de embeddings a algo accionable.
 *
 * `RagService.retrieve` atrapa cualquier error y devuelve lista vacia —es un
 * fail-safe deliberado—, asi que desde fuera un 429 de Voyage y un «no hay nada
 * por encima del umbral» son indistinguibles, y son diagnosticos OPUESTOS: uno
 * se arregla esperando veinte segundos y el otro tocando el umbral o la base.
 */
export function explicarFalloDeEmbeddings(mensaje: string): string {
  if (/\b429\b/.test(mensaje)) {
    return 'limite de Voyage (3 peticiones/minuto en el plan gratuito): espera ~20 s. No es el prompt.';
  }
  if (/VOYAGE_API_KEY/.test(mensaje)) return 'falta VOYAGE_API_KEY: el RAG no puede funcionar.';
  if (/dimensiones/.test(mensaje)) return `desajuste de dimensiones del vector: ${mensaje}`;
  return `fallo del proveedor de embeddings: ${mensaje}`;
}

// ---------------------------------------------------------------------------
// Espias sobre los puertos
// ---------------------------------------------------------------------------

/** Solo existe para saber POR QUE fallo el RAG; no altera el comportamiento. */
class EspiaDeEmbeddings implements EmbeddingPort {
  constructor(
    private readonly real: EmbeddingPort,
    private readonly registro: RegistroDelTurno,
  ) {}

  get dimensions(): number {
    return this.real.dimensions;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    try {
      return await this.real.embed(texts, kind);
    } catch (err) {
      this.registro.falloDeEmbeddings = explicarFalloDeEmbeddings(
        err instanceof Error ? err.message : String(err),
      );
      throw err; // el fail-safe de RagService sigue siendo el que decide
    }
  }
}

export class EspiaDeRag implements RagPort {
  constructor(
    private readonly real: RagPort,
    private readonly registro: RegistroDelTurno,
  ) {}

  async retrieve(clinicId: string, query: string, limit?: number): Promise<KnowledgeChunk[]> {
    const fragmentos = await this.real.retrieve(clinicId, query, limit);
    this.registro.consultasRag.push({
      consulta: query,
      fragmentos: fragmentos.map((f) => ({
        id: f.id,
        fuente: f.fuente,
        similitud: f.similarity,
        contenido: f.contenido,
      })),
      ...(fragmentos.length === 0
        ? {
            motivoVacio:
              this.registro.falloDeEmbeddings ?? 'ningun fragmento supero el umbral de similitud',
          }
        : {}),
    });
    return fragmentos;
  }
}

/**
 * Espia de capa 2. Registra SOLO las intervenciones (`pass: false`).
 *
 * `checkOutbound` se invoca varias veces por turno sobre prefijos crecientes
 * del texto en streaming, asi que la misma violacion llega repetida; se
 * deduplica por motivo para que el panel no mienta sobre cuantas veces
 * intervino de verdad.
 */
export interface VerificadorDeGuardrails {
  checkInbound(text: string, channel: Channel, ctx?: TurnContext): GuardrailResult;
  checkOutbound(text: string, ctx: TurnContext, evidence?: OutboundEvidence): GuardrailResult;
}

export class EspiaDeGuardrails implements VerificadorDeGuardrails {
  constructor(
    private readonly real: VerificadorDeGuardrails,
    private readonly registro: RegistroDelTurno,
  ) {}

  checkInbound(text: string, channel: Channel, ctx?: TurnContext): GuardrailResult {
    return this.real.checkInbound(text, channel, ctx);
  }

  checkOutbound(text: string, ctx: TurnContext, evidence?: OutboundEvidence): GuardrailResult {
    const resultado = this.real.checkOutbound(text, ctx, evidence);
    if (!resultado.pass) {
      const motivo = resultado.reason ?? 'sin motivo declarado';
      const yaVisto = this.registro.capa2.find((i) => i.motivo === motivo);
      if (!yaVisto) {
        this.registro.capa2.push({ motivo, sustituto: resultado.replacement, textoDelModelo: text });
      } else if (text.length > yaVisto.textoDelModelo.length) {
        // Los prefijos van creciendo; interesa el texto mas completo que el
        // modelo llego a producir, no el primer trozo que disparo el control.
        yaVisto.textoDelModelo = text;
      }
    }
    return resultado;
  }
}

// ---------------------------------------------------------------------------
// Entornos
// ---------------------------------------------------------------------------

interface HerramientaEjecutada {
  herramienta: string;
  estado: string;
}

interface Entorno {
  modo: Modo;
  servicio: ConversationServiceImpl;
  urgencia: UrgencyDetector;
  clinica: Clinic;
  registro: RegistroDelTurno;
  /** Descripcion honesta de con que esta hablando el usuario. */
  avisos: string[];
  umbralRag: number | undefined;
  herramientasDe(conversationId: string): Promise<HerramientaEjecutada[]>;
}

/** Silencioso: el informe lo da la interfaz, no el stdout. */
function loggerMudo(): Logger {
  const nada = (): void => {};
  const logger: Logger = {
    fatal: nada,
    error: nada,
    warn: nada,
    info: nada,
    debug: nada,
    child: () => logger,
  };
  return logger;
}

async function construirEntornoReal(): Promise<Entorno> {
  const config = loadConfig();
  const logger = loggerMudo();
  const registro = new RegistroDelTurno();
  const supabase = createSupabaseClient(config);

  const clinics = new SupabaseClinicRepository(supabase);
  const patients = new SupabasePatientRepository(supabase);
  const conversations = new SupabaseConversationRepository(supabase);
  const messages = new SupabaseMessageRepository(supabase);
  const toolCalls = new SupabaseToolCallRepository(supabase);
  const audit = new SupabaseAuditRepository(supabase);

  const clinicId = process.env['CLINIC_ID'] ?? '00000000-0000-4000-8000-000000000001';
  const clinica = await clinics.findById(clinicId);
  if (!clinica) {
    throw new Error(`No existe la clinica ${clinicId}. ¿Ejecutaste \`npm run db:seed\`?`);
  }

  const calendar = new GoogleCalendarClient(clinics, config, logger);
  const notifications = new NotificationClient({
    ...(config.N8N_WEBHOOK_URL ? { webhookUrl: config.N8N_WEBHOOK_URL } : {}),
    logger,
  });

  const embeddings = new EspiaDeEmbeddings(
    new VoyageEmbeddingService({
      ...(config.VOYAGE_API_KEY ? { apiKey: config.VOYAGE_API_KEY } : {}),
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
    }),
    registro,
  );
  const rag = new EspiaDeRag(
    new RagService(embeddings, new SupabaseKnowledgeRepository(supabase), logger, {
      umbralSimilitud: config.RAG_UMBRAL_SIMILITUD,
    }),
    registro,
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

  const promptBuilder = new PromptBuilder(await loadPromptTemplates(join(RAIZ, 'prompts')));
  const guardrails = new EspiaDeGuardrails(new GuardrailService({ logger, audit }), registro);
  const urgencia = new UrgencyDetector({
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

  const servicio = new ConversationServiceImpl(
    { router, claude, promptBuilder, rag, urgency: urgencia, guardrails, tools, messages, logger, audit },
    { model: config.CLAUDE_MODEL_CONVERSACION, maxTokens: config.CLAUDE_MAX_TOKENS },
  );

  const avisos = [
    'Cada turno ESCRIBE en Supabase: paciente, conversacion y mensajes reales.',
    'Voyage en plan gratuito: 3 peticiones/minuto. Si escribes rapido, el RAG vendra vacio.',
  ];
  if (!config.N8N_WEBHOOK_URL) {
    avisos.push(
      'Falta N8N_WEBHOOK_URL: si el agente escala, el aviso NO llega a ninguna persona.',
    );
  }

  return {
    modo: 'real',
    servicio,
    urgencia,
    clinica,
    registro,
    avisos,
    umbralRag: config.RAG_UMBRAL_SIMILITUD,
    herramientasDe: async (conversationId) => {
      const { data } = await supabase
        .from('tool_calls')
        .select('herramienta,estado')
        .eq('conversation_id', conversationId)
        .order('creado_en', { ascending: false })
        .limit(10);
      return (data ?? []) as HerramientaEjecutada[];
    },
  };
}

async function construirEntornoDobles(): Promise<Entorno> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY: el modelo es real incluso en modo dobles.');

  const crudo = JSON.parse(
    await readFile(join(RAIZ, 'db', 'seed', 'clinica-demo', 'clinica.json'), 'utf8'),
  ) as { id: string; nombre: string; timezone: string; config: Record<string, unknown>; transfer_whitelist: string[] };
  const clinica: Clinic = {
    id: crudo.id,
    nombre: crudo.nombre,
    timezone: crudo.timezone,
    config: crudo.config,
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: crudo.transfer_whitelist,
  };

  const logger = loggerMudo();
  const registro = new RegistroDelTurno();
  const dobles = crearDobles(clinica);
  const ragDemo = await RagDeDemostracion.cargar(clinica.id);
  const rag = new EspiaDeRag(ragDemo, registro);

  const modelo = process.env['CLAUDE_MODEL_CONVERSACION'] ?? 'claude-sonnet-5';
  const claude = new ClaudeService({
    config: {
      apiKey,
      modelPorDefecto: modelo,
      maxTokens: Number(process.env['CLAUDE_MAX_TOKENS'] ?? 1024),
      temperature: Number(process.env['CLAUDE_TEMPERATURE'] ?? 0.3),
    },
    logger,
  });

  const promptBuilder = new PromptBuilder(await loadPromptTemplates(join(RAIZ, 'prompts')));
  const guardrails = new EspiaDeGuardrails(
    new GuardrailService({ logger, audit: dobles.auditoria }),
    registro,
  );
  const urgencia = new UrgencyDetector({
    claude,
    logger,
    prompt: promptBuilder.promptDeUrgencia,
    model: process.env['CLAUDE_MODEL_CLASIFICACION'] ?? 'claude-haiku-4-5-20251001',
  });

  // Registro propio, no el de `crearDobles`: aquel cablea `consultar_rag` al
  // `RagDoble` vacio, y entonces la herramienta y el orquestador consultarian
  // bases distintas. Aqui las dos ven el mismo RAG de demostracion.
  const tools = new ToolRegistryImpl(
    [
      new ConsultarAgendaTool(dobles.calendar, dobles.toolCalls, logger),
      new CrearCitaTool(dobles.calendar, dobles.toolCalls, logger),
      new ConsultarRagTool(rag, dobles.toolCalls, logger),
      new GuardarLeadTool(dobles.auditoria, dobles.toolCalls, logger),
      new EscalarHumanoTool(dobles.notificaciones, dobles.conversaciones, dobles.toolCalls, logger),
    ],
    dobles.toolCalls,
    logger,
  );

  const router = new MessageRouter(
    {
      clinics: dobles.clinicas,
      patients: dobles.pacientes,
      conversations: dobles.conversaciones,
      messages: dobles.mensajes,
      logger,
    },
    { regionPorDefecto: 'PE' },
  );

  const servicio = new ConversationServiceImpl(
    {
      router,
      claude,
      promptBuilder,
      rag,
      urgency: urgencia,
      guardrails,
      tools,
      messages: dobles.mensajes,
      logger,
      audit: dobles.auditoria,
    },
    { model: modelo },
  );

  return {
    modo: 'dobles',
    servicio,
    urgencia,
    clinica,
    registro,
    avisos: [
      `El modelo SI es real. Todo lo demas es un doble en memoria: al cerrar, se pierde.`,
      `RAG por coincidencia de palabras sobre ${ragDemo.total} fragmentos, no busqueda vectorial: recupera menos y peor que el real.`,
      'La agenda es en memoria: las citas que crees no salen en Google Calendar.',
    ],
    umbralRag: undefined,
    herramientasDe: (conversationId) =>
      Promise.resolve(
        dobles.toolCalls.filas
          .filter((f) => f.conversationId === conversationId)
          .slice(-10)
          .reverse()
          .map((f) => ({ herramienta: f.herramienta, estado: f.estado })),
      ),
  };
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

/** Comparacion en tiempo constante; longitudes distintas no deben filtrar nada. */
export function tokenValido(esperado: string, recibido: unknown): boolean {
  if (typeof recibido !== 'string') return false;
  const a = Buffer.from(esperado);
  const b = Buffer.from(recibido);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Primera IPv4 no interna: la que sirve para abrirlo desde el movil. */
function ipDeLaRed(): string | undefined {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const i of interfaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return undefined;
}

interface CuerpoDeTurno {
  texto: string;
  canal: Channel;
  modo: Modo;
  telefono: string;
}

async function main(): Promise<void> {
  const argumentos = process.argv.slice(2);
  const enRed = argumentos.includes('--red');
  const iPuerto = argumentos.indexOf('--puerto');
  const puerto = iPuerto === -1 ? 4545 : Number(argumentos[iPuerto + 1] ?? 4545);
  const modoInicial: Modo = argumentos.includes('--dobles') ? 'dobles' : 'real';

  const token = randomUUID();
  const pagina = await readFile(join(RAIZ, 'scripts', 'consola.html'), 'utf8');

  // Los entornos se construyen la primera vez que se usan y se guardan: montar
  // el real exige `.env` completo y una consulta a Supabase, y no tiene sentido
  // pagarlo si solo se va a usar el de dobles.
  const entornos = new Map<Modo, Entorno>();
  const construir: Record<Modo, () => Promise<Entorno>> = {
    real: construirEntornoReal,
    dobles: construirEntornoDobles,
  };
  const obtenerEntorno = async (modo: Modo): Promise<Entorno> => {
    const guardado = entornos.get(modo);
    if (guardado) return guardado;
    const nuevo = await construir[modo]();
    entornos.set(modo, nuevo);
    return nuevo;
  };

  /**
   * Un turno cada vez. Los espias acumulan en un registro por entorno, asi que
   * dos turnos solapados mezclarian sus paneles: se veria el RAG de uno bajo la
   * respuesta del otro. Una consola de inspeccion que miente sobre lo que
   * observo no sirve para nada.
   */
  let enCurso: Promise<unknown> = Promise.resolve();
  const enSerie = async <T>(fn: () => Promise<T>): Promise<T> => {
    const mio = enCurso.then(fn, fn);
    enCurso = mio.catch(() => undefined);
    return mio;
  };

  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  app.addHook('onRequest', async (peticion, respuesta) => {
    if (peticion.url.startsWith('/salud')) return;
    const query = peticion.query as Record<string, unknown> | undefined;
    const recibido = peticion.headers['x-consola-token'] ?? query?.['t'];
    if (!tokenValido(token, recibido)) {
      await respuesta
        .code(401)
        .type('text/plain; charset=utf-8')
        .send('Token invalido o ausente. Abre la URL completa que imprimio `npm run consola`.\n');
    }
  });

  app.get('/salud', async () => ({ estado: 'ok' }));

  app.get('/', async (_peticion, respuesta) => {
    await respuesta.type('text/html; charset=utf-8').send(pagina);
  });

  app.get('/api/estado', async (peticion) => {
    const query = peticion.query as { modo?: string };
    const modo: Modo = query.modo === 'dobles' ? 'dobles' : modoInicial;
    try {
      const entorno = await obtenerEntorno(modo);
      return {
        ok: true,
        modo: entorno.modo,
        clinica: entorno.clinica.nombre,
        timezone: entorno.clinica.timezone,
        umbralRag: entorno.umbralRag,
        avisos: entorno.avisos,
        modelo: process.env['CLAUDE_MODEL_CONVERSACION'] ?? 'claude-sonnet-5',
        modeloClasificacion:
          process.env['CLAUDE_MODEL_CLASIFICACION'] ?? 'claude-haiku-4-5-20251001',
      };
    } catch (error) {
      return { ok: false, modo, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/turno', async (peticion, respuesta) => {
    const cuerpo = peticion.body as Partial<CuerpoDeTurno>;
    const texto = (cuerpo.texto ?? '').trim();
    const canal: Channel = cuerpo.canal === 'voice' ? 'voice' : 'whatsapp';
    const modo: Modo = cuerpo.modo === 'dobles' ? 'dobles' : 'real';
    const telefono = cuerpo.telefono ?? '+51999000123';

    respuesta.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emitir = (evento: Record<string, unknown>): void => {
      respuesta.raw.write(`data: ${JSON.stringify(evento)}\n\n`);
    };

    if (texto.length === 0) {
      emitir({ tipo: 'error', mensaje: 'mensaje vacio' });
      respuesta.raw.end();
      return;
    }

    await enSerie(async () => {
      const empezado = Date.now();
      try {
        const entorno = await obtenerEntorno(modo);
        entorno.registro.reiniciar();

        // Capa 1 es sincrona y pura: se puede enseñar antes de gastar un token.
        emitir({ tipo: 'capa1', banderas: detectInboundFlags(texto, canal) });

        let conversationId = '';
        let escalamiento: unknown;
        for await (const trozo of entorno.servicio.streamTurn({
          clinicId: entorno.clinica.id,
          patientPhoneE164: telefono,
          text: texto,
          channel: canal,
          receivedAt: new Date(),
        })) {
          if (trozo.type === 'text') emitir({ tipo: 'texto', delta: trozo.delta });
          else if (trozo.type === 'tool_call') emitir({ tipo: 'herramienta', nombre: trozo.name, args: trozo.args });
          else if (trozo.type === 'escalate') {
            escalamiento = trozo.request;
            emitir({ tipo: 'escalado', peticion: trozo.request });
          } else if (trozo.type === 'done') {
            conversationId = trozo.message.conversationId;
            emitir({
              tipo: 'fin',
              conversationId,
              latenciaMs: trozo.message.latencyMs,
              // El troceado REAL de WhatsApp, no una aproximacion: asi se ve en
              // cuantas burbujas le llegaria al paciente.
              burbujas: canal === 'whatsapp' ? formatOutboundMessage(trozo.message.text) : undefined,
            });
          }
        }

        // Capa 3 desnuda: en una urgencia explicita responde el pre-filtro
        // lexico y el modelo no llega ni a hablar, asi que sin esto una
        // degradacion del clasificador quedaria tapada en los casos graves.
        let veredicto: string | undefined;
        try {
          veredicto = (await entorno.urgencia.clasificar(texto))?.veredicto ?? 'ININTELIGIBLE';
        } catch (err) {
          veredicto = `no se pudo consultar: ${err instanceof Error ? err.message : String(err)}`;
        }

        emitir({
          tipo: 'inspeccion',
          rag: entorno.registro.consultasRag,
          capa2: entorno.registro.capa2,
          capa3: { escalamiento, veredictoDesnudo: veredicto },
          herramientas: conversationId ? await entorno.herramientasDe(conversationId) : [],
          totalMs: Date.now() - empezado,
        });
      } catch (error) {
        emitir({ tipo: 'error', mensaje: error instanceof Error ? error.message : String(error) });
      } finally {
        respuesta.raw.end();
      }
    });
  });

  await app.listen({ port: puerto, host: enRed ? '0.0.0.0' : '127.0.0.1' });

  const url = (anfitrion: string): string => `http://${anfitrion}:${puerto}/?t=${token}`;
  const lineas = [
    '',
    '  CONSOLA DE INSPECCION — Recepcion-IA',
    '',
    `  Modo inicial: ${modoInicial}${modoInicial === 'real' ? '  (usa --dobles para no gastar ni escribir)' : ''}`,
    '',
    `  Aqui:      ${url('localhost')}`,
  ];
  if (enRed) {
    const ip = ipDeLaRed();
    lineas.push(`  Movil:     ${ip ? url(ip) : '(no se encontro IPv4 en la red local)'}`);
    lineas.push('');
    lineas.push('  ESCUCHANDO EN TODA LA RED LOCAL. El token es lo unico que protege');
    lineas.push('  tu cuenta de Anthropic y tu base de datos. No compartas la URL.');
  } else {
    lineas.push('');
    lineas.push('  Solo esta maquina. Usa --red para abrirlo desde el movil.');
  }
  lineas.push('');
  process.stdout.write(lineas.join('\n') + '\n');
}

// Solo arranca si se ejecuta directamente: importarlo desde un test no levanta nada.
if (esEntradaPrincipal(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(1);
  });
}
