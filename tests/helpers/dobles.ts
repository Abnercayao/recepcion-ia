/**
 * Dobles en memoria de TODOS los puertos de frontera (`core/types/ports.ts`).
 *
 * Deterministas y sin red: ninguna clase de este archivo abre un socket, lee un
 * archivo ni consulta la hora del sistema sin que se pueda sustituir el reloj.
 * Estan pensados para reutilizarse desde cualquier rama; por eso viven aqui y
 * no dentro de un test concreto.
 *
 * Convencion: cada doble expone su estado interno como propiedad publica de
 * solo lectura (`filas`, `eventos`, `escalamientos`, ...) para que el test
 * afirme sobre lo que de verdad se persistio, no sobre lo que se devolvio.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RespuestaDelClasificador,
  Veredicto,
} from '../../src/core/urgency/urgency.detector.js';
import type {
  AuditRepository,
  CalendarEvent,
  CalendarPort,
  CalendarSlot,
  Channel,
  ClaudeCallOptions,
  ClaudePort,
  ClaudeStreamChunk,
  ClaudeToolUse,
  Clinic,
  ClinicRepository,
  Conversation,
  ConversationEstado,
  ConversationRepository,
  EscalationRequest,
  KnowledgeChunk,
  Logger,
  MessageRepository,
  MessageRol,
  Patient,
  PatientRepository,
  RagPort,
  StoredMessage,
  ToolCallRecord,
  ToolCallRepository,
  ToolRegistry,
  TurnContext,
  NotificationPort,
} from '../../src/core/types/index.js';
import type { ToolLoopResult } from '../../src/core/claude/claude.service.js';
import { GuardrailService } from '../../src/core/claude/guardrails.js';
import {
  PromptBuilder,
  loadPromptTemplates,
  type PromptTemplates,
} from '../../src/core/claude/prompt.builder.js';
import { UrgencyDetector } from '../../src/core/urgency/urgency.detector.js';
import {
  ConversationServiceImpl,
  type ConversationServiceOptions,
} from '../../src/core/conversation/conversation.service.js';
import {
  MessageRouter,
  type MessageRouterOptions,
} from '../../src/core/conversation/message.router.js';
import { ToolRegistryImpl } from '../../src/core/tools/tool.registry.js';
import { ConsultarAgendaTool } from '../../src/core/tools/consultar-agenda.tool.js';
import { ConsultarRagTool } from '../../src/core/tools/consultar-rag.tool.js';
import { CrearCitaTool } from '../../src/core/tools/crear-cita.tool.js';
import { EscalarHumanoTool } from '../../src/core/tools/escalar-humano.tool.js';
import { GuardarLeadTool } from '../../src/core/tools/guardar-lead.tool.js';

// ---------------------------------------------------------------------------
// Observabilidad
// ---------------------------------------------------------------------------

export interface LineaDeLog {
  nivel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
  obj: Record<string, unknown>;
  msg?: string;
}

/** Logger silencioso que guarda todo. Los tests afirman sobre `lineas`. */
export class LoggerDoble implements Logger {
  readonly lineas: LineaDeLog[] = [];

  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  fatal(obj: Record<string, unknown>, msg?: string): void {
    this.escribir('fatal', obj, msg);
  }
  error(obj: Record<string, unknown>, msg?: string): void {
    this.escribir('error', obj, msg);
  }
  warn(obj: Record<string, unknown>, msg?: string): void {
    this.escribir('warn', obj, msg);
  }
  info(obj: Record<string, unknown>, msg?: string): void {
    this.escribir('info', obj, msg);
  }
  debug(obj: Record<string, unknown>, msg?: string): void {
    this.escribir('debug', obj, msg);
  }

  /** Los hijos comparten el array: un test no deberia perseguir la jerarquia. */
  child(bindings: Record<string, unknown>): Logger {
    const hijo = new LoggerDoble({ ...this.bindings, ...bindings });
    (hijo as { lineas: LineaDeLog[] }).lineas = this.lineas;
    return hijo;
  }

  /** Todas las lineas de un nivel, por comodidad del test. */
  de(nivel: LineaDeLog['nivel']): LineaDeLog[] {
    return this.lineas.filter((l) => l.nivel === nivel);
  }

  private escribir(nivel: LineaDeLog['nivel'], obj: Record<string, unknown>, msg?: string): void {
    this.lineas.push({ nivel, obj: { ...this.bindings, ...obj }, msg });
  }
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

/**
 * Un paso del guion del modelo. Si trae `toolUses`, el doble las emite, ejecuta
 * el callback del bucle de herramientas y pasa al siguiente paso; si no, cierra
 * el turno.
 */
export interface PasoDeClaude {
  texto?: string;
  toolUses?: ClaudeToolUse[];
  /** Troceado explicito del texto. Por defecto se trocea por palabras. */
  trozos?: string[];
  stopReason?: string;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Respuesta del clasificador de urgencia, construida desde el tipo REAL.
 *
 * No se escribe el JSON a mano a proposito: un doble con el contrato viejo no
 * falla, miente en silencio, y es exactamente asi como el defecto del umbral de
 * confianza sobrevivio a una suite en verde. Tipada, un cambio de contrato es
 * un error de `tsc`.
 */
export const respuestaDelClasificador = (
  veredicto: Veredicto,
  senales: string[] = [],
): string => JSON.stringify({ veredicto, senales } satisfies RespuestaDelClasificador);

/**
 * Doble del modelo. No hay aleatoriedad: emite exactamente el guion que se le
 * da, en el orden en que se le dio.
 */
export class ClaudeDoble implements ClaudePort {
  /** Llamadas conversacionales (`stream` y `streamLoop`), en orden. */
  readonly llamadas: ClaudeCallOptions[] = [];
  /** Llamadas de `complete` (las usa el clasificador de urgencia). */
  readonly llamadasDeComplete: ClaudeCallOptions[] = [];
  /** Argumentos con los que se invoco cada herramienta, en orden. */
  readonly herramientasEjecutadas: ClaudeToolUse[] = [];

  private readonly guion: PasoDeClaude[] = [];

  /** Respuesta de `complete`. Por defecto, el clasificador dice «no urgente». */
  respuestaDeComplete: (opts: ClaudeCallOptions) => { text: string; toolUses: ClaudeToolUse[] } = () => ({
    text: respuestaDelClasificador('sin_urgencia'),
    toolUses: [],
  });

  constructor(guion: PasoDeClaude[] = []) {
    this.guion.push(...guion);
  }

  /** Encola pasos. Cada `streamLoop` consume los que necesite. */
  encolar(...pasos: PasoDeClaude[]): this {
    this.guion.push(...pasos);
    return this;
  }

  /** Atajo: un turno de solo texto. */
  responder(texto: string): this {
    return this.encolar({ texto });
  }

  async complete(opts: ClaudeCallOptions): Promise<{ text: string; toolUses: ClaudeToolUse[] }> {
    this.llamadasDeComplete.push(opts);
    return this.respuestaDeComplete(opts);
  }

  async *stream(opts: ClaudeCallOptions): AsyncIterable<ClaudeStreamChunk> {
    this.llamadas.push(opts);
    const paso = this.guion.shift() ?? {};
    yield* this.emitirPaso(paso);
    yield {
      type: 'end',
      stopReason: paso.stopReason ?? 'end_turn',
      tokensIn: paso.tokensIn ?? 0,
      tokensOut: paso.tokensOut ?? 0,
    };
  }

  /**
   * Reproduce el contrato de `ClaudeService.streamLoop`: emite texto y
   * `tool_use`, ejecuta las herramientas pedidas y vuelve a por el siguiente
   * paso del guion. El `end` sale una sola vez, al final, con los tokens
   * acumulados.
   */
  async *streamLoop(
    opts: ClaudeCallOptions,
    ejecutar: (toolUse: ClaudeToolUse) => Promise<ToolLoopResult>,
    maxIteraciones = 5,
  ): AsyncIterable<ClaudeStreamChunk> {
    this.llamadas.push(opts);
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = 'end_turn';

    for (let i = 0; i < maxIteraciones; i += 1) {
      const paso = this.guion.shift() ?? {};
      tokensIn += paso.tokensIn ?? 0;
      tokensOut += paso.tokensOut ?? 0;
      stopReason = paso.stopReason ?? 'end_turn';

      yield* this.emitirPaso(paso);

      const herramientas = paso.toolUses ?? [];
      if (herramientas.length === 0) break;
      for (const herramienta of herramientas) {
        this.herramientasEjecutadas.push(herramienta);
        await ejecutar(herramienta);
      }
    }

    yield { type: 'end', stopReason, tokensIn, tokensOut };
  }

  private async *emitirPaso(paso: PasoDeClaude): AsyncIterable<ClaudeStreamChunk> {
    const trozos = paso.trozos ?? (paso.texto !== undefined ? trocearPorPalabras(paso.texto) : []);
    for (const trozo of trozos) {
      yield { type: 'text', delta: trozo };
    }
    for (const toolUse of paso.toolUses ?? []) {
      yield { type: 'tool_use', toolUse };
    }
  }
}

/** Trocea conservando los espacios, como haria un stream real. */
export function trocearPorPalabras(texto: string): string[] {
  return texto.match(/\S+\s*/g) ?? [];
}

// ---------------------------------------------------------------------------
// Conocimiento
// ---------------------------------------------------------------------------

export class RagDoble implements RagPort {
  readonly consultas: Array<{ clinicId: string; query: string; limit?: number }> = [];
  /** Fragmentos por consulta exacta. Lo que no este aqui recibe `porDefecto`. */
  readonly porConsulta = new Map<string, KnowledgeChunk[]>();
  porDefecto: KnowledgeChunk[] = [];

  constructor(porDefecto: KnowledgeChunk[] = []) {
    this.porDefecto = porDefecto;
  }

  async retrieve(clinicId: string, query: string, limit?: number): Promise<KnowledgeChunk[]> {
    this.consultas.push({ clinicId, query, limit });
    const fragmentos = this.porConsulta.get(query) ?? this.porDefecto;
    // El aislamiento por clinica es absoluto (C9): el doble tampoco lo rompe.
    return fragmentos.filter((f) => f.clinicId === clinicId).slice(0, limit ?? fragmentos.length);
  }
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

export class CalendarDoble implements CalendarPort {
  /** Huecos que devuelve `findAvailableSlots`, antes de filtrar por rango. */
  slots: CalendarSlot[] = [];
  readonly eventos: CalendarEvent[] = [];
  /** Si es false, `isSlotFree` devuelve siempre false (colision forzada). */
  todoLibre = true;

  async findAvailableSlots(
    _clinicId: string,
    from: Date,
    to: Date,
    _durationMin: number,
  ): Promise<CalendarSlot[]> {
    return this.slots.filter((s) => s.start >= from && s.end <= to);
  }

  async isSlotFree(_clinicId: string, start: Date, end: Date): Promise<boolean> {
    if (!this.todoLibre) return false;
    return !this.eventos.some((e) => e.start < end && start < e.end);
  }

  async createEvent(
    _clinicId: string,
    event: Omit<CalendarEvent, 'id'>,
    _patientPhone: string,
  ): Promise<CalendarEvent> {
    const creado: CalendarEvent = { id: randomUUID(), ...event };
    this.eventos.push(creado);
    return creado;
  }

  async cancelEvent(_clinicId: string, eventId: string): Promise<void> {
    const i = this.eventos.findIndex((e) => e.id === eventId);
    if (i >= 0) this.eventos.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Notificacion
// ---------------------------------------------------------------------------

export class NotificationDoble implements NotificationPort {
  readonly escalamientos: Array<{ ctx: TurnContext; request: EscalationRequest }> = [];
  /** Si es true, `notifyEscalation` lanza: sirve para probar el modo degradado. */
  falla = false;

  async notifyEscalation(ctx: TurnContext, request: EscalationRequest): Promise<void> {
    if (this.falla) throw new Error('canal de notificacion caido (doble)');
    this.escalamientos.push({ ctx, request });
  }
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

export class ClinicRepositoryDoble implements ClinicRepository {
  readonly filas = new Map<string, Clinic>();

  constructor(clinicas: Clinic[] = []) {
    for (const c of clinicas) this.filas.set(c.id, c);
  }

  async findById(clinicId: string): Promise<Clinic | null> {
    return this.filas.get(clinicId) ?? null;
  }
}

export class PatientRepositoryDoble implements PatientRepository {
  readonly filas: Patient[] = [];

  /** upsert por (clinicId, telefonoE164): el telefono ES la identidad. */
  async upsert(clinicId: string, telefonoE164: string, nombre?: string): Promise<Patient> {
    const existente = this.filas.find(
      (p) => p.clinicId === clinicId && p.telefonoE164 === telefonoE164,
    );
    if (existente) {
      if (nombre !== undefined && nombre !== '') existente.nombre = nombre;
      return existente;
    }
    const nuevo: Patient = { id: randomUUID(), clinicId, telefonoE164, nombre };
    this.filas.push(nuevo);
    return nuevo;
  }
}

export class ConversationRepositoryDoble implements ConversationRepository {
  readonly filas: Conversation[] = [];
  /** Reloj sustituible: la ventana de continuidad se prueba moviendo el tiempo. */
  reloj: () => Date = () => new Date();
  /**
   * Estados que se consideran reutilizables. `ports.ts` habla de conversacion
   * «activa» sin cerrar la lista; se incluye `escalada` para que un paciente que
   * sigue escribiendo tras un escalamiento no acabe con la conversacion partida
   * en dos. Es una decision del doble, ajustable por el test.
   */
  estadosReutilizables: ConversationEstado[] = ['activa', 'escalada'];

  async findActiveWithin(
    clinicId: string,
    patientId: string,
    since: Date,
  ): Promise<Conversation | null> {
    const candidatas = this.filas
      .filter(
        (c) =>
          c.clinicId === clinicId &&
          c.patientId === patientId &&
          this.estadosReutilizables.includes(c.estado) &&
          c.ultimaActividad.getTime() >= since.getTime(),
      )
      .sort((a, b) => b.ultimaActividad.getTime() - a.ultimaActividad.getTime());
    return candidatas[0] ?? null;
  }

  async create(clinicId: string, patientId: string, canal: Channel): Promise<Conversation> {
    const ahora = this.reloj();
    const nueva: Conversation = {
      id: randomUUID(),
      clinicId,
      patientId,
      estado: 'activa',
      canalOrigen: canal,
      ultimoCanal: canal,
      iniciadaEn: ahora,
      ultimaActividad: ahora,
    };
    this.filas.push(nueva);
    return nueva;
  }

  async touch(conversationId: string, ultimoCanal: Channel): Promise<void> {
    const fila = this.filas.find((c) => c.id === conversationId);
    if (!fila) return;
    fila.ultimoCanal = ultimoCanal;
    fila.ultimaActividad = this.reloj();
  }

  async markEscalated(conversationId: string, motivo: string): Promise<void> {
    const fila = this.filas.find((c) => c.id === conversationId);
    if (!fila) return;
    fila.estado = 'escalada';
    fila.escaladaEn = this.reloj();
    fila.escaladaMotivo = motivo;
  }
}

export class MessageRepositoryDoble implements MessageRepository {
  readonly filas: StoredMessage[] = [];
  reloj: () => Date = () => new Date();

  async append(msg: {
    conversationId: string;
    rol: MessageRol;
    contenido: string;
    canal: Channel;
    sessionId?: string;
    tokensIn?: number;
    tokensOut?: number;
    latenciaMs?: number;
  }): Promise<StoredMessage> {
    const fila: StoredMessage = { id: randomUUID(), ...msg, creadoEn: this.reloj() };
    this.filas.push(fila);
    return fila;
  }

  /** Ultimos `limit` mensajes, en orden cronologico ascendente. */
  async listByConversation(conversationId: string, limit?: number): Promise<StoredMessage[]> {
    const todos = this.filas.filter((m) => m.conversationId === conversationId);
    return limit === undefined ? [...todos] : todos.slice(Math.max(0, todos.length - limit));
  }

  /** Comodidad del test: los mensajes de una conversacion con un rol dado. */
  de(conversationId: string, rol: MessageRol): StoredMessage[] {
    return this.filas.filter((m) => m.conversationId === conversationId && m.rol === rol);
  }
}

export class ToolCallRepositoryDoble implements ToolCallRepository {
  readonly filas: ToolCallRecord[] = [];

  async record(call: ToolCallRecord): Promise<void> {
    this.filas.push(call);
  }

  async countByTool(conversationId: string, herramienta: string): Promise<number> {
    return this.filas.filter((c) => c.conversationId === conversationId && c.herramienta === herramienta)
      .length;
  }
}

export interface EventoDeAuditoria {
  evento: string;
  detalle: Record<string, unknown>;
  clinicId?: string;
  conversationId?: string;
}

export class AuditRepositoryDoble implements AuditRepository {
  readonly filas: EventoDeAuditoria[] = [];

  async log(
    evento: string,
    detalle: Record<string, unknown>,
    clinicId?: string,
    conversationId?: string,
  ): Promise<void> {
    this.filas.push({ evento, detalle, clinicId, conversationId });
  }

  /** Comodidad del test. */
  con(evento: string): EventoDeAuditoria[] {
    return this.filas.filter((f) => f.evento === evento);
  }
}

// ---------------------------------------------------------------------------
// Clinica de prueba y fabrica
// ---------------------------------------------------------------------------

export const CLINICA_DE_PRUEBA: Clinic = {
  id: '11111111-1111-4111-8111-111111111111',
  nombre: 'Clinica Dental Sonrisa',
  timezone: 'America/Lima',
  config: { sede: 'Miraflores', horario: { horaApertura: '08:00', horaCierre: '20:00' } },
  retencionTranscripcionDias: 365,
  retencionAudioDias: 0,
  transferWhitelist: ['+51987000111'],
};

export interface Dobles {
  logger: LoggerDoble;
  claude: ClaudeDoble;
  rag: RagDoble;
  calendar: CalendarDoble;
  notificaciones: NotificationDoble;
  clinicas: ClinicRepositoryDoble;
  pacientes: PatientRepositoryDoble;
  conversaciones: ConversationRepositoryDoble;
  mensajes: MessageRepositoryDoble;
  toolCalls: ToolCallRepositoryDoble;
  auditoria: AuditRepositoryDoble;
  /** Registro con las CINCO herramientas reales sobre los dobles de arriba. */
  registro: ToolRegistry;
  clinica: Clinic;
}

/**
 * Monta el juego completo de dobles con las herramientas reales encima.
 *
 * Se usan las herramientas de verdad a proposito: sus validaciones defensivas
 * (colision de agenda, lista blanca de transferencia, confirmacion explicita)
 * son parte de lo que un test de integracion tiene que ejercitar.
 */
export function crearDobles(clinica: Clinic = CLINICA_DE_PRUEBA): Dobles {
  const logger = new LoggerDoble();
  const claude = new ClaudeDoble();
  const rag = new RagDoble();
  const calendar = new CalendarDoble();
  const notificaciones = new NotificationDoble();
  const clinicas = new ClinicRepositoryDoble([clinica]);
  const pacientes = new PatientRepositoryDoble();
  const conversaciones = new ConversationRepositoryDoble();
  const mensajes = new MessageRepositoryDoble();
  const toolCalls = new ToolCallRepositoryDoble();
  const auditoria = new AuditRepositoryDoble();

  const registro = new ToolRegistryImpl(
    [
      new ConsultarAgendaTool(calendar, toolCalls, logger),
      new CrearCitaTool(calendar, toolCalls, logger),
      new ConsultarRagTool(rag, toolCalls, logger),
      new GuardarLeadTool(auditoria, toolCalls, logger),
      new EscalarHumanoTool(notificaciones, conversaciones, toolCalls, logger),
    ],
    toolCalls,
    logger,
  );

  return {
    logger,
    claude,
    rag,
    calendar,
    notificaciones,
    clinicas,
    pacientes,
    conversaciones,
    mensajes,
    toolCalls,
    auditoria,
    registro,
    clinica,
  };
}

// ---------------------------------------------------------------------------
// Entorno completo: dobles + las piezas REALES del nucleo
// ---------------------------------------------------------------------------

const DIRECTORIO_DE_PROMPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../prompts',
);

/**
 * Las plantillas se leen del disco UNA vez por proceso: son fijas durante la
 * vida del proceso, igual que en produccion, y releerlas por test solo anadiria
 * ruido de E/S.
 */
let plantillasCache: Promise<PromptTemplates> | undefined;
export function plantillasDePrompt(): Promise<PromptTemplates> {
  plantillasCache ??= loadPromptTemplates(DIRECTORIO_DE_PROMPTS);
  return plantillasCache;
}

export interface EntornoDePrueba extends Dobles {
  servicio: ConversationServiceImpl;
  promptBuilder: PromptBuilder;
  guardrails: GuardrailService;
  urgencia: UrgencyDetector;
  router: MessageRouter;
}

export interface OpcionesDeEntorno {
  clinica?: Clinic;
  router?: MessageRouterOptions;
  servicio?: ConversationServiceOptions;
  /** Presupuesto del clasificador de urgencia. Corto a proposito en tests. */
  timeoutUrgenciaMs?: number;
}

/**
 * Monta el nucleo COMPLETO con dobles solo en la frontera.
 *
 * PromptBuilder, GuardrailService, UrgencyDetector, el registro de herramientas
 * y el propio ConversationService son los reales, con los prompts reales de
 * `prompts/`. Lo unico simulado es lo que sale del proceso: modelo, RAG,
 * calendario, notificacion y base de datos. Es lo que hace que un test de
 * integracion signifique algo.
 */
export async function crearEntornoDePrueba(
  opciones: OpcionesDeEntorno = {},
): Promise<EntornoDePrueba> {
  const dobles = crearDobles(opciones.clinica ?? CLINICA_DE_PRUEBA);
  const promptBuilder = new PromptBuilder(await plantillasDePrompt());
  const guardrails = new GuardrailService({ logger: dobles.logger, audit: dobles.auditoria });
  const urgencia = new UrgencyDetector({
    claude: dobles.claude,
    logger: dobles.logger,
    prompt: promptBuilder.promptDeUrgencia,
    model: 'modelo-de-clasificacion-de-prueba',
    timeoutMs: opciones.timeoutUrgenciaMs ?? 500,
  });
  const router = new MessageRouter(
    {
      clinics: dobles.clinicas,
      patients: dobles.pacientes,
      conversations: dobles.conversaciones,
      messages: dobles.mensajes,
      logger: dobles.logger,
    },
    opciones.router ?? {},
  );
  const servicio = new ConversationServiceImpl(
    {
      router,
      claude: dobles.claude,
      promptBuilder,
      rag: dobles.rag,
      urgency: urgencia,
      guardrails,
      tools: dobles.registro,
      messages: dobles.mensajes,
      logger: dobles.logger,
      audit: dobles.auditoria,
    },
    opciones.servicio ?? {},
  );

  return { ...dobles, servicio, promptBuilder, guardrails, urgencia, router };
}

/**
 * Parte un `system` ya renderizado en sus bloques `## `.
 *
 * Reimplementa a proposito la particion de `prompt.builder.ts` en vez de
 * importarla: el test tiene que poder detectar que el ensamblado cambio de
 * forma, y si compartiera la funcion, un cambio en ella pasaria inadvertido.
 */
export function partirSystemEnBloques(system: string): string[] {
  const bloques: string[] = [];
  let actual: string[] | undefined;
  for (const linea of system.split(/\r?\n/)) {
    if (linea.startsWith('## ')) {
      if (actual) bloques.push(actual.join('\n').trimEnd());
      actual = [linea];
    } else if (actual) {
      actual.push(linea);
    }
  }
  if (actual) bloques.push(actual.join('\n').trimEnd());
  return bloques;
}
