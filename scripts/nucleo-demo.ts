/**
 * Montaje del NUCLEO REAL para demostraciones.
 *
 * Lo comparten la demo de terminal (`scripts/demo.ts`) y la web local
 * (`scripts/web.ts`). Se extrajo aqui para que ambas ejerciten exactamente el
 * mismo sistema: si la web se comportara distinto que la terminal, la
 * demostracion no probaria nada.
 *
 * Que es real: el prompt maestro, los guardrails de tres capas, el detector de
 * urgencia, las cinco herramientas, la validacion de sus argumentos, la
 * continuidad de la conversacion y el modelo.
 *
 * Que NO es real, y por que:
 *   - La persistencia es en memoria. Al cerrar el proceso, se pierde. Evita
 *     tener que levantar Supabase solo para probar la conversacion.
 *   - La recuperacion de conocimiento usa coincidencia de PALABRAS sobre los
 *     documentos de `db/seed/clinica-demo/`, no busqueda vectorial. Asi no hace
 *     falta clave de embeddings. Es PEOR que el RAG real: recupera menos y
 *     peor. Si el agente dice que no tiene un dato que si esta en la base,
 *     sospecha de esto antes que del prompt.
 *   - La agenda es en memoria: las citas que se creen no salen en Google
 *     Calendar.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ClaudeService } from '../src/core/claude/claude.service.js';
import { GuardrailService } from '../src/core/claude/guardrails.js';
import { PromptBuilder, loadPromptTemplates } from '../src/core/claude/prompt.builder.js';
import { UrgencyDetector } from '../src/core/urgency/urgency.detector.js';
import { MessageRouter } from '../src/core/conversation/message.router.js';
import { ConversationServiceImpl } from '../src/core/conversation/conversation.service.js';
import { chunkText } from '../src/core/rag/chunker.js';
import type { Clinic, KnowledgeChunk, Logger, RagPort } from '../src/core/types/index.js';
import { crearDobles } from '../tests/helpers/dobles.js';

const RAIZ = resolve(import.meta.dirname, '..');
const DIR_SEMILLA = join(RAIZ, 'db', 'seed', 'clinica-demo');

// ---------------------------------------------------------------------------
// RAG de demostracion: coincidencia de palabras, sin embeddings
// ---------------------------------------------------------------------------

/** Palabras vacias del espanol: no aportan senal y ensucian el solapamiento. */
const VACIAS = new Set(
  ('a al algo alguna alguno ante antes aqui asi aunque cada como con contra cual cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa ese eso esta estan este esto ha hace hacen hasta hay la las le les lo los mas me mi mucho muy no nos o os otra otro para pero poco por porque que quien se ser si sin sobre solo son su sus tambien tan te tiene tienen todo todos tu un una uno unos y ya').split(
    ' ',
  ),
);

function tokenizar(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !VACIAS.has(t));
}

const FUENTES: Array<[string, KnowledgeChunk['fuente']]> = [
  ['formulario-maestro.md', 'formulario'],
  ['faqs.md', 'faq'],
  ['protocolo-urgencias.md', 'protocolo_urgencia'],
];

export class RagDeDemostracion implements RagPort {
  private constructor(
    private readonly clinicId: string,
    private readonly fragmentos: Array<{ chunk: KnowledgeChunk; tokens: Set<string> }>,
  ) {}

  static async cargar(clinicId: string): Promise<RagDeDemostracion> {
    const fragmentos: Array<{ chunk: KnowledgeChunk; tokens: Set<string> }> = [];

    for (const [archivo, fuente] of FUENTES) {
      const contenido = await readFile(join(DIR_SEMILLA, archivo), 'utf8');
      // Mismo criterio que el cargador real: el FAQ se fragmenta por parrafo
      // para no mezclar preguntas sin relacion en un mismo fragmento.
      const trozos = chunkText(
        { contenido, fuente, version: 1 },
        fuente === 'faq' ? { unParrafoPorFragmento: true } : {},
      );
      for (const [i, trozo] of trozos.entries()) {
        fragmentos.push({
          chunk: { id: `${fuente}-${i}`, clinicId, contenido: trozo.contenido, fuente },
          tokens: new Set(tokenizar(trozo.contenido)),
        });
      }
    }

    return new RagDeDemostracion(clinicId, fragmentos);
  }

  get total(): number {
    return this.fragmentos.length;
  }

  retrieve(clinicId: string, query: string, limit = 5): Promise<KnowledgeChunk[]> {
    // El aislamiento entre clinicas se respeta tambien aqui, aunque el demo
    // tenga una sola: es la invariante mas importante del sistema.
    if (clinicId !== this.clinicId) return Promise.resolve([]);

    const consulta = tokenizar(query);
    if (consulta.length === 0) return Promise.resolve([]);

    const puntuados = this.fragmentos
      .map(({ chunk, tokens }) => {
        const comunes = consulta.filter((t) => tokens.has(t)).length;
        return { chunk, score: comunes / consulta.length };
      })
      .filter((f) => f.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return Promise.resolve(puntuados.map((p) => ({ ...p.chunk, similarity: p.score })));
  }
}

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

export async function clinicaDeLaSemilla(): Promise<Clinic> {
  const crudo = JSON.parse(await readFile(join(DIR_SEMILLA, 'clinica.json'), 'utf8')) as {
    id: string;
    nombre: string;
    timezone: string;
    config: Record<string, unknown>;
    transfer_whitelist: string[];
  };

  return {
    id: crudo.id,
    nombre: crudo.nombre,
    timezone: crudo.timezone,
    config: crudo.config,
    retencionTranscripcionDias: 365,
    retencionAudioDias: 0,
    transferWhitelist: crudo.transfer_whitelist,
  };
}

/** Logger silencioso salvo errores: en una demo el ruido estorba. */
export function loggerDeConsola(): Logger {
  const emitir =
    (nivel: string) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      if (nivel === 'error' || nivel === 'fatal') {
        console.error(`\n  [${nivel}] ${msg ?? ''}`, obj['error'] ?? '');
      }
    };
  const logger: Logger = {
    fatal: emitir('fatal'),
    error: emitir('error'),
    warn: emitir('warn'),
    info: emitir('info'),
    debug: emitir('debug'),
    child: () => logger,
  };
  return logger;
}

export interface NucleoDeDemostracion {
  servicio: ConversationServiceImpl;
  clinica: Clinic;
  rag: RagDeDemostracion;
  dobles: ReturnType<typeof crearDobles>;
  modelo: string;
  modeloClasificacion: string;
}

export class FaltaLaClaveError extends Error {
  constructor() {
    super(
      'Falta ANTHROPIC_API_KEY.\n\n' +
        'Ponla en el archivo .env de la raiz del proyecto:\n' +
        '  ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Se obtiene en https://console.anthropic.com/settings/keys',
    );
    this.name = 'FaltaLaClaveError';
  }
}

/**
 * Levanta el nucleo real con infraestructura de demostracion.
 * Lanza `FaltaLaClaveError` si no hay clave: es lo unico que necesita.
 */
export async function montarNucleoDeDemostracion(): Promise<NucleoDeDemostracion> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new FaltaLaClaveError();

  const modelo = process.env['CLAUDE_MODEL_CONVERSACION'] ?? 'claude-sonnet-5';
  const modeloClasificacion =
    process.env['CLAUDE_MODEL_CLASIFICACION'] ?? 'claude-haiku-4-5-20251001';

  const clinica = await clinicaDeLaSemilla();
  const logger = loggerDeConsola();
  const dobles = crearDobles(clinica);
  const rag = await RagDeDemostracion.cargar(clinica.id);

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
  const guardrails = new GuardrailService({ logger, audit: dobles.auditoria });
  const urgency = new UrgencyDetector({
    claude,
    logger,
    prompt: promptBuilder.promptDeUrgencia,
    model: modeloClasificacion,
  });
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
      urgency,
      guardrails,
      tools: dobles.registro,
      messages: dobles.mensajes,
      logger,
      audit: dobles.auditoria,
    },
    { model: modelo },
  );

  return { servicio, clinica, rag, dobles, modelo, modeloClasificacion };
}
