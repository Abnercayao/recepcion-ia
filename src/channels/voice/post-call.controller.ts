/**
 * post-call.controller.ts
 *
 * Webhook POST-LLAMADA de ElevenLabs (docs/contrato-elevenlabs.md §7). Es la
 * ultima pieza del canal de voz y la unica del sistema que VE la transcripcion
 * real de la llamada; por eso es aqui -y no en el gateway- donde se verifica de
 * verdad la revelacion obligatoria (§7 de la especificacion).
 *
 * Traduce, no decide, igual que el resto de `channels/` (anti-patron 2): no hay
 * ni una regla de negocio en este archivo. Lo que hace es consolidar en `calls`
 * y `transcripts` lo que el proveedor reporta cuando la llamada ya termino.
 *
 * RUTA (absoluta, declarada dentro del plugin como hace el gateway de voz, para
 * que quien componga no tenga que acordarse de un prefijo):
 *   POST /webhooks/elevenlabs/post-call
 *
 * ---------------------------------------------------------------------------
 * CUERPO CRUDO PARA LA FIRMA
 * ---------------------------------------------------------------------------
 * Mismo patron que `whatsapp.controller.ts`: Fastify parsea JSON por defecto y
 * no expone el buffer original, pero el HMAC se calcula sobre los BYTES que
 * mando el proveedor, no sobre el objeto parseado y reserializado. Se sustituye
 * el content-type parser de 'application/json' por uno propio con
 * `parseAs: 'buffer'` que guarda el crudo en `request.rawBody` y hace el
 * `JSON.parse` el mismo. Se registra DENTRO del plugin, asi que por la
 * encapsulacion de Fastify no afecta al parseo de ninguna otra ruta.
 *
 * ---------------------------------------------------------------------------
 * ACK INMEDIATO
 * ---------------------------------------------------------------------------
 * Se responde 200 en cuanto la firma es valida y el procesamiento sigue
 * despues, igual que en WhatsApp: un webhook que tarda se reintenta, y un
 * reintento vuelve a entregar la misma llamada. La reconciliacion de
 * transcripcion de mas abajo es lo que hace que un reintento no duplique nada.
 * `handlePostCallWebhookEvent` se exporta por separado para poder probarlo de
 * forma determinista, sin depender de los tiempos de Fastify tras el `send()`.
 *
 * ---------------------------------------------------------------------------
 * VACIO DETECTADO #1 — no hay `findByElevenlabsConversationId`
 * ---------------------------------------------------------------------------
 * `db/migrations/001_init.sql` crea `idx_calls_elevenlabs_conversation`
 * declarando literalmente que existe PARA este webhook, pero el puerto
 * `CallRepository` (`voice.types.ts`, fuera de mi alcance) solo ofrece
 * `findBySessionId` y `findById`. No puedo anadir el metodo sin tocar un archivo
 * ajeno. Se resuelve buscando por `session_id` -que es NUESTRO identificador,
 * el que viaja en `elevenlabs_extra_body`- leyendolo de las ubicaciones donde
 * el proveedor lo devuelve, y usando el `conversation_id` de ElevenLabs como
 * ultimo recurso. Cuando la fila se encuentra y aun no tiene
 * `elevenlabs_conversation_id`, se escribe: a partir de ahi el enlace entre los
 * dos identificadores queda hecho. **Falta anadir
 * `findByElevenlabsConversationId(id)` al puerto**; ver informe.
 *
 * ---------------------------------------------------------------------------
 * VACIO DETECTADO #2 — `clinic_id` no es alcanzable desde una llamada
 * ---------------------------------------------------------------------------
 * La politica de retencion de audio vive en `clinics.retencion_audio_dias`,
 * pero `calls` no tiene `clinic_id` y `ConversationRepository` no expone un
 * `findById`, asi que desde una fila de `calls` no hay camino hasta la clinica.
 * La politica se recibe por inyeccion (`retencionAudioDias`, que en la raiz de
 * composicion es `config.RETENCION_AUDIO_DIAS`) y se combina con el flag por
 * llamada `calls.retencion_audio`. Con una sola clinica por despliegue son el
 * mismo valor; con varias, esto habria que resolverlo por clinica.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyElevenLabsWebhookSignature } from '../../infra/elevenlabs.client.js';
import type { AuditRepository, Logger } from '../../core/types/index.js';
import type {
  CallRecord,
  CallRepository,
  CallStatus,
  Hablante,
  NuevaLineaDeTranscripcion,
  TranscriptRepository,
} from './voice.types.js';

// `rawBody` no existe en FastifyRequest de fabrica. La declaracion es identica
// a la de whatsapp.controller.ts a proposito: TypeScript fusiona ambas sin
// conflicto y este archivo no depende de que aquel se importe.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Ruta absoluta del webhook. Se declara aqui para que la composicion no necesite prefijo. */
export const RUTA_WEBHOOK_POST_LLAMADA = '/webhooks/elevenlabs/post-call';

// ---------------------------------------------------------------------------
// Forma del payload (docs/contrato-elevenlabs.md §7)
// ---------------------------------------------------------------------------

/**
 * Una linea de `data.transcript[]`.
 *
 * Todo opcional a proposito: el contrato enumera los campos de `data` pero no
 * fija la forma exacta de cada entrada. Un campo con otro nombre no puede tirar
 * la consolidacion de una llamada que ya ocurrio.
 */
export const postCallTranscriptEntrySchema = z
  .object({
    role: z.string().optional(),
    message: z.union([z.string(), z.null()]).optional(),
    time_in_call_secs: z.number().optional(),
  })
  .passthrough();

export const postCallDataSchema = z
  .object({
    agent_id: z.string().optional(),
    conversation_id: z.string().optional(),
    status: z.string().optional(),
    transcript: z.array(postCallTranscriptEntrySchema).optional(),
    has_audio: z.boolean().optional(),
    /** MP3 en base64. NUNCA se persiste ni se loguea: ver `descartarAudio`. */
    full_audio: z.string().optional(),
    /** `busy` | `no-answer` | `unknown` (§7). Se acepta cualquier cadena y se normaliza. */
    failure_reason: z.string().optional(),
  })
  .passthrough();

export const postCallWebhookPayloadSchema = z
  .object({
    type: z.string().optional(),
    /** Segundos desde epoch, como el resto de timestamps del proveedor. */
    event_timestamp: z.number().optional(),
    data: postCallDataSchema,
  })
  .passthrough();

export type PostCallWebhookPayload = z.infer<typeof postCallWebhookPayloadSchema>;

export type TipoDePayloadPostLlamada = 'transcripcion' | 'audio' | 'fallo_de_inicio' | 'desconocido';

/**
 * Clasifica por FORMA, no solo por el campo `type`.
 *
 * El contrato confirma las tres variantes de `data` pero no los literales
 * exactos de `type` para todas ellas (§8 advierte ademas de un rebranding con
 * rutas y nombres en migracion). Discriminar por los campos que si estan
 * confirmados -`failure_reason`, `full_audio`, `transcript`- es lo que hace que
 * esto siga funcionando si el proveedor renombra el evento. `type` se usa solo
 * como pista cuando la forma no es concluyente.
 */
export function clasificarPayload(payload: PostCallWebhookPayload): TipoDePayloadPostLlamada {
  const data = payload.data;
  if (typeof data.failure_reason === 'string' && data.failure_reason.trim() !== '') {
    return 'fallo_de_inicio';
  }
  if (typeof data.full_audio === 'string' && data.full_audio.length > 0) return 'audio';
  if (Array.isArray(data.transcript)) return 'transcripcion';

  const tipo = payload.type?.toLowerCase() ?? '';
  if (tipo.includes('audio')) return 'audio';
  if (tipo.includes('transcription') || tipo.includes('transcript')) return 'transcripcion';
  if (tipo.includes('failure') || tipo.includes('failed')) return 'fallo_de_inicio';
  return 'desconocido';
}

export type MotivoDeFallo = 'busy' | 'no-answer' | 'unknown';

/** Cualquier valor no reconocido cae en `unknown`: el crudo se conserva en la auditoria. */
export function normalizarMotivoDeFallo(bruto: string | undefined): MotivoDeFallo {
  const v = bruto?.trim().toLowerCase().replace(/_/g, '-');
  if (v === 'busy' || v === 'no-answer') return v;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Revelacion obligatoria (§7 de la especificacion, docs/contrato-elevenlabs.md §6)
// ---------------------------------------------------------------------------

/**
 * Sin tildes ni mayusculas: el texto se normaliza antes de comparar, asi que
 * los patrones se escriben ya en su forma normalizada.
 *
 * Solo se aceptan formulas que digan que el interlocutor NO es humano. «Le
 * atiende Ana» o «soy el asistente de la clinica» no valen: la obligacion es
 * que el paciente sepa que habla con una IA, no que le suene amable.
 */
const PATRONES_DE_IA: readonly RegExp[] = [
  /inteligencia artificial/,
  /asistente virtual/,
  /agente virtual/,
  /sistema automatizado/,
  /\bno soy (una|un) persona\b/,
  /\bno una persona\b/,
  /\bsoy una ia\b/,
  /\bsoy un bot\b/,
];

/** Segundo elemento exigible: que la conversacion se graba. */
const PATRONES_DE_GRABACION: readonly RegExp[] = [/grabad/, /grabacion/, /\bse graba\b/, /\bgrabar\b/];

/** Minusculas y sin diacriticos. Las comparaciones de cumplimiento no pueden depender de una tilde. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface ResultadoDeRevelacion {
  /** Se aviso de que es una IA y no una persona. */
  mencionaIa: boolean;
  /** Se aviso de que la conversacion se graba. */
  mencionaGrabacion: boolean;
  /** Los DOS elementos. La obligacion es conjunta, no alternativa. */
  cumple: boolean;
}

/**
 * Comprueba el guion de revelacion sobre la PRIMERA intervencion del agente.
 *
 * La obligacion (docs/contrato-elevenlabs.md §6) exige notificar, antes de
 * cualquier interaccion, (1) que se interactua con IA y no con una persona y
 * (2) que la conversacion se graba y puede compartirse. Se comprueban los dos:
 * uno solo no cumple.
 *
 * LIMITACION DECLARADA: esto verifica que el guion SE DIJO segun la
 * transcripcion del proveedor, no que el paciente lo oyera ni que se emitiera
 * antes de nada. Es la mejor evidencia disponible del lado del servidor, y es
 * estrictamente mejor que inferirla de que la llamada existio.
 */
export function verificarGuionDeRevelacion(primeraIntervencionDelAgente: string): ResultadoDeRevelacion {
  const texto = normalizarTexto(primeraIntervencionDelAgente);
  const mencionaIa = PATRONES_DE_IA.some((p) => p.test(texto));
  const mencionaGrabacion = PATRONES_DE_GRABACION.some((p) => p.test(texto));
  return { mencionaIa, mencionaGrabacion, cumple: mencionaIa && mencionaGrabacion };
}

// ---------------------------------------------------------------------------
// Reconciliacion de transcripcion
// ---------------------------------------------------------------------------

/**
 * Forma canonica para comparar dos lineas: sin diacriticos, sin puntuacion y
 * con los espacios colapsados. El proveedor y el gateway no puntuan igual la
 * misma frase, y una coma de diferencia no puede convertirse en una linea
 * duplicada.
 */
export function normalizarParaComparar(texto: string): string {
  return normalizarTexto(texto)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Umbral por debajo del cual NO se aplica la comparacion por contencion.
 * «si», «no», «claro» aparecen dentro de casi cualquier frase; tratarlas como
 * la misma linea borraria intervenciones legitimas.
 */
const LONGITUD_MINIMA_PARA_CONTENCION = 12;

interface LineaDelProveedor {
  hablante: Hablante;
  texto: string;
  tsInicioMs?: number;
}

/** Mapea el rol del proveedor a nuestro enum. Un rol desconocido descarta la linea. */
export function aHablante(role: string | undefined): Hablante | undefined {
  const r = role?.trim().toLowerCase();
  if (r === undefined) return undefined;
  if (r === 'agent' || r === 'assistant' || r === 'ai' || r === 'agente') return 'agente';
  if (r === 'user' || r === 'human' || r === 'customer' || r === 'patient' || r === 'paciente') {
    return 'paciente';
  }
  return undefined;
}

export function lineasDelPayload(payload: PostCallWebhookPayload): LineaDelProveedor[] {
  const entradas = payload.data.transcript ?? [];
  const lineas: LineaDelProveedor[] = [];
  for (const entrada of entradas) {
    const hablante = aHablante(entrada.role);
    if (!hablante) continue;
    const texto = typeof entrada.message === 'string' ? entrada.message.trim() : '';
    if (texto === '') continue;
    const linea: LineaDelProveedor = { hablante, texto };
    if (typeof entrada.time_in_call_secs === 'number' && Number.isFinite(entrada.time_in_call_secs)) {
      linea.tsInicioMs = Math.round(entrada.time_in_call_secs * 1000);
    }
    lineas.push(linea);
  }
  return lineas;
}

export interface ResultadoDeReconciliacion {
  anadidas: number;
  yaPresentes: number;
  descartadas: number;
}

interface LineaExistente {
  hablante: Hablante;
  normalizada: string;
  consumida: boolean;
}

/**
 * Empareja cada linea del proveedor con una linea que el gateway YA escribio
 * turno a turno (`voice-session.service.ts` lo pide explicitamente: «el webhook
 * de la Fase 5 debe RECONCILIAR con estas lineas, no anadirlas otra vez»).
 *
 * Se empareja por MULTICONJUNTO -cada linea existente se consume una sola vez-
 * para que una frase repetida de verdad («si», dos veces) siga contando dos
 * veces, en lugar de colapsar en una. Cuando no hay coincidencia exacta se
 * prueba por contencion, porque el gateway pudo anteponer la expresion puente
 * («Un momento, por favor... ») a lo que el agente dijo despues.
 *
 * AMBIGUEDAD DECLARADA: dos intervenciones identicas y consecutivas son
 * indistinguibles de un duplicado si el gateway solo registro una. El sesgo
 * elegido es NO duplicar: una transcripcion con lineas repetidas deja de servir
 * como evidencia, y perder una repeticion exacta cuesta mucho menos.
 */
export function planificarReconciliacion(
  delProveedor: readonly LineaDelProveedor[],
  yaPersistidas: ReadonlyArray<{ hablante: Hablante; texto: string }>,
): { aAnadir: LineaDelProveedor[]; yaPresentes: number } {
  const existentes: LineaExistente[] = yaPersistidas.map((l) => ({
    hablante: l.hablante,
    normalizada: normalizarParaComparar(l.texto),
    consumida: false,
  }));

  const aAnadir: LineaDelProveedor[] = [];
  let yaPresentes = 0;

  for (const linea of delProveedor) {
    const normalizada = normalizarParaComparar(linea.texto);
    if (normalizada === '') continue;

    let coincidencia = existentes.find(
      (e) => !e.consumida && e.hablante === linea.hablante && e.normalizada === normalizada,
    );

    if (!coincidencia && normalizada.length >= LONGITUD_MINIMA_PARA_CONTENCION) {
      coincidencia = existentes.find(
        (e) =>
          !e.consumida &&
          e.hablante === linea.hablante &&
          e.normalizada.length >= LONGITUD_MINIMA_PARA_CONTENCION &&
          (e.normalizada.includes(normalizada) || normalizada.includes(e.normalizada)),
      );
    }

    if (coincidencia) {
      coincidencia.consumida = true;
      yaPresentes += 1;
      continue;
    }
    aAnadir.push(linea);
  }

  return { aAnadir, yaPresentes };
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export interface PostCallDeps {
  calls: CallRepository;
  transcripts: TranscriptRepository;
  /** `audit_log` es inalterable (migracion 003): es donde vive la evidencia de cumplimiento. */
  audit: AuditRepository;
  logger: Logger;
  /**
   * `config.ELEVENLABS_WEBHOOK_SECRET`. Es un secreto DISTINTO de
   * `VOICE_GATEWAY_SECRET` (contrato §2 vs §7): confundirlos deja el webhook sin
   * verificar. Vacio = el endpoint rechaza TODO con 401 (falla cerrado).
   */
  webhookSecret: string;
  /**
   * `config.RETENCION_AUDIO_DIAS`. `0` = no se retiene audio. Ver VACIO
   * DETECTADO #2 sobre por que no se lee de la clinica.
   */
  retencionAudioDias: number;
  /** Ventana de tolerancia del timestamp firmado. Por defecto la del cliente (300 s). */
  toleranceSeconds?: number;
  /**
   * Limite de cuerpo de ESTA ruta. Sin informar hereda el del servidor (1 MiB),
   * que un payload de audio supera con holgura. Ver la nota sobre audio en
   * `docs/fase5-elevenlabs.md`.
   */
  bodyLimitBytes?: number;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Lectura defensiva de campos no confirmados
// ---------------------------------------------------------------------------

function leerRuta(raiz: unknown, ruta: readonly string[]): unknown {
  let actual: unknown = raiz;
  for (const clave of ruta) {
    if (typeof actual !== 'object' || actual === null) return undefined;
    actual = (actual as Record<string, unknown>)[clave];
  }
  return actual;
}

function textoEn(raiz: unknown, ruta: readonly string[]): string | undefined {
  const valor = leerRuta(raiz, ruta);
  if (typeof valor !== 'string') return undefined;
  const limpio = valor.trim();
  return limpio === '' ? undefined : limpio;
}

function numeroEn(raiz: unknown, ruta: readonly string[]): number | undefined {
  const valor = leerRuta(raiz, ruta);
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
}

/**
 * Ubicaciones donde el proveedor puede devolver NUESTRO `session_id`.
 *
 * Ninguna esta confirmada por la documentacion: el `session_id` lo ponemos
 * nosotros en `elevenlabs_extra_body` al iniciar la conversacion, y donde
 * reaparece en el payload post-llamada depende de como se configure el agente.
 * Se prueban todas las razonables en vez de apostar por una.
 */
const RUTAS_DE_SESSION_ID: ReadonlyArray<readonly string[]> = [
  ['conversation_initiation_client_data', 'dynamic_variables', 'session_id'],
  ['conversation_initiation_client_data', 'elevenlabs_extra_body', 'session_id'],
  ['metadata', 'session_id'],
  ['metadata', 'custom_data', 'session_id'],
  ['session_id'],
];

export function sessionIdDelPayload(payload: PostCallWebhookPayload): string | undefined {
  for (const ruta of RUTAS_DE_SESSION_ID) {
    const valor = textoEn(payload.data, ruta);
    if (valor !== undefined) return valor;
  }
  return undefined;
}

/** Duracion en segundos. Los tres nombres se han visto en distintas versiones de la documentacion. */
export function duracionDelPayload(payload: PostCallWebhookPayload): number | undefined {
  return (
    numeroEn(payload.data, ['metadata', 'call_duration_secs']) ??
    numeroEn(payload.data, ['metadata', 'call_duration_seconds']) ??
    numeroEn(payload.data, ['metadata', 'duration_secs'])
  );
}

// ---------------------------------------------------------------------------
// Estado final de la llamada
// ---------------------------------------------------------------------------

/**
 * `transferida` NO se pisa.
 *
 * Una llamada derivada a una persona tambien «termina», pero sobrescribirla con
 * `finalizada` borraria el unico rastro de que hubo escalamiento -que es
 * justo lo que mide el criterio «100 % urgencias escaladas». El estado se
 * conserva y la hora de fin y la duracion se consolidan igual.
 */
export function mapearEstadoFinal(statusDelProveedor: string | undefined, actual: CallStatus): CallStatus {
  if (actual === 'transferida') return 'transferida';
  const s = statusDelProveedor?.trim().toLowerCase() ?? '';
  if (s === 'failed' || s === 'error' || s === 'fallida') return 'fallida';
  return 'finalizada';
}

// ---------------------------------------------------------------------------
// Procesamiento
// ---------------------------------------------------------------------------

export interface ResultadoPostLlamada {
  tipo: TipoDePayloadPostLlamada;
  callId?: string;
  /** `undefined` si el payload no permitia comprobarla (audio, fallo de inicio). */
  disclosureCumple?: boolean;
  reconciliacion?: ResultadoDeReconciliacion;
  audioDescartado?: boolean;
  /** Por que no se pudo hacer mas. Solo se informa cuando algo se detuvo. */
  motivo?: string;
}

/** Nunca lanza: una auditoria perdida no puede tumbar la consolidacion de la llamada. */
async function auditar(
  deps: PostCallDeps,
  evento: string,
  detalle: Record<string, unknown>,
  conversationId?: string,
): Promise<void> {
  try {
    await deps.audit.log(evento, detalle, undefined, conversationId);
  } catch (err) {
    deps.logger.error(
      { evento, error: err instanceof Error ? err.message : String(err) },
      'webhook post-llamada: no se pudo escribir en audit_log',
    );
  }
}

/** Evento de audio, best effort. Mismo criterio que `voice-session.service.ts`. */
async function registrarEvento(
  deps: PostCallDeps,
  callId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.calls.appendAudioEvent({ callId, tipo: 'fin', ts: (deps.now ?? (() => new Date()))(), payload });
  } catch (err) {
    deps.logger.error(
      { callId, error: err instanceof Error ? err.message : String(err) },
      'webhook post-llamada: no se pudo registrar el evento de fin',
    );
  }
}

/**
 * Localiza la fila de `calls` que corresponde a este webhook y enlaza los dos
 * identificadores. Ver VACIO DETECTADO #1 sobre por que no se busca
 * directamente por `elevenlabs_conversation_id`.
 */
async function resolverLlamada(
  deps: PostCallDeps,
  payload: PostCallWebhookPayload,
): Promise<CallRecord | null> {
  const conversationId = payload.data.conversation_id;
  const candidatos: string[] = [];
  const sessionId = sessionIdDelPayload(payload);
  if (sessionId !== undefined) candidatos.push(sessionId);
  // Ultimo recurso: hay despliegues donde el `session_id` que se inyecta ES el
  // identificador de conversacion del proveedor.
  if (conversationId !== undefined && conversationId !== sessionId) candidatos.push(conversationId);

  for (const candidato of candidatos) {
    let call: CallRecord | null = null;
    try {
      call = await deps.calls.findBySessionId(candidato);
    } catch (err) {
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'webhook post-llamada: fallo la busqueda de la llamada',
      );
      return null;
    }
    if (!call) continue;

    if (conversationId !== undefined && call.elevenlabsConversationId !== conversationId) {
      try {
        // Deja el enlace hecho para futuros webhooks de la MISMA llamada
        // (el de audio llega despues del de transcripcion).
        await deps.calls.update(call.id, { elevenlabsConversationId: conversationId });
      } catch (err) {
        deps.logger.error(
          { callId: call.id, error: err instanceof Error ? err.message : String(err) },
          'webhook post-llamada: no se pudo enlazar elevenlabs_conversation_id',
        );
      }
    }
    return call;
  }
  return null;
}

/**
 * Descarta el audio SIN escribirlo (control C8).
 *
 * El audio de una llamada de salud es dato biometrico asociado a dato de salud.
 * Guardarlo «por si acaso» es el anti-patron 8, y ademas no habria donde: el
 * esquema no tiene ni columna ni almacen para audio. Aqui no se persiste, no se
 * loguea el base64 y solo queda constancia de que llego y se tiro.
 */
async function descartarAudio(
  deps: PostCallDeps,
  payload: PostCallWebhookPayload,
  call: CallRecord | null,
): Promise<ResultadoPostLlamada> {
  const base64 = payload.data.full_audio ?? '';
  // Tamano aproximado del MP3 sin decodificar: solo para el registro. El
  // contenido no se toca.
  const bytes = Math.floor((base64.length * 3) / 4);

  const politicaProhibeRetener = deps.retencionAudioDias === 0 || call?.retencionAudio === false;

  const detalle: Record<string, unknown> = {
    call_id: call?.id,
    bytes_aproximados: bytes,
    retencion_audio_dias: deps.retencionAudioDias,
    retencion_audio_de_la_llamada: call?.retencionAudio ?? null,
    motivo: politicaProhibeRetener ? 'politica_de_retencion_cero' : 'sin_almacen_de_audio',
  };

  if (politicaProhibeRetener) {
    deps.logger.info(
      { callId: call?.id, bytesAproximados: bytes },
      'webhook post-llamada: audio recibido y descartado sin escribirlo (retencion de audio desactivada)',
    );
  } else {
    // Contradiccion real: la politica permite retener pero el sistema no tiene
    // donde. Se descarta igual y se dice en voz alta, en vez de fingir que se
    // guardo algo.
    deps.logger.error(
      { callId: call?.id, retencionAudioDias: deps.retencionAudioDias },
      'webhook post-llamada: la politica permite retener audio pero no hay almacen implementado; el audio se descarta',
    );
  }

  await auditar(deps, 'audio_post_llamada_descartado', detalle, call?.conversationId);

  const resultado: ResultadoPostLlamada = { tipo: 'audio', audioDescartado: true };
  if (call) resultado.callId = call.id;
  else resultado.motivo = 'llamada_no_encontrada';
  return resultado;
}

/** Consolida transcripcion, revelacion y cierre de la llamada. */
async function procesarTranscripcion(
  deps: PostCallDeps,
  payload: PostCallWebhookPayload,
  call: CallRecord,
  ahora: Date,
): Promise<ResultadoPostLlamada> {
  const lineas = lineasDelPayload(payload);

  // --- 1. Reconciliacion con lo que ya escribio el gateway -----------------
  let reconciliacion: ResultadoDeReconciliacion = { anadidas: 0, yaPresentes: 0, descartadas: 0 };
  try {
    const existentes = await deps.transcripts.listByCall(call.id);
    const plan = planificarReconciliacion(lineas, existentes);
    if (plan.aAnadir.length > 0) {
      const nuevas: NuevaLineaDeTranscripcion[] = plan.aAnadir.map((l) => ({
        callId: call.id,
        hablante: l.hablante,
        texto: l.texto,
        ...(l.tsInicioMs !== undefined ? { tsInicioMs: l.tsInicioMs } : {}),
      }));
      await deps.transcripts.appendMany(nuevas);
    }
    reconciliacion = {
      anadidas: plan.aAnadir.length,
      yaPresentes: plan.yaPresentes,
      descartadas: (payload.data.transcript?.length ?? 0) - lineas.length,
    };
  } catch (err) {
    deps.logger.error(
      { callId: call.id, error: err instanceof Error ? err.message : String(err) },
      'webhook post-llamada: fallo la reconciliacion de la transcripcion',
    );
  }

  // --- 2. Revelacion obligatoria (criterio BLOQUEANTE) --------------------
  const primeraDelAgente = lineas.find((l) => l.hablante === 'agente');
  const revision = primeraDelAgente
    ? verificarGuionDeRevelacion(primeraDelAgente.texto)
    : { mencionaIa: false, mencionaGrabacion: false, cumple: false };

  if (revision.cumple) {
    try {
      await deps.calls.marcarDisclosureEjecutada(call.id);
    } catch (err) {
      deps.logger.error(
        { callId: call.id, error: err instanceof Error ? err.message : String(err) },
        'webhook post-llamada: no se pudo marcar disclosure_ejecutada pese a verificarla',
      );
    }
    await auditar(
      deps,
      'disclosure_verificada',
      { call_id: call.id, evidencia: 'primera_intervencion_del_agente_en_la_transcripcion' },
      call.conversationId,
    );
  } else {
    // Nivel `error` a proposito: es incumplimiento de una obligacion
    // contractual y regulatoria, no una anomalia operativa. El texto NO se
    // loguea (regla 8); la evidencia queda en `transcripts` bajo el mismo
    // call_id, que es donde tiene que estar.
    deps.logger.error(
      {
        callId: call.id,
        mencionaIa: revision.mencionaIa,
        mencionaGrabacion: revision.mencionaGrabacion,
        huboIntervencionDelAgente: primeraDelAgente !== undefined,
      },
      'INCUMPLIMIENTO: la primera intervencion del agente no contiene el guion de revelacion (§7). Criterio bloqueante',
    );
    await auditar(
      deps,
      'disclosure_incumplida',
      {
        call_id: call.id,
        menciona_ia: revision.mencionaIa,
        menciona_grabacion: revision.mencionaGrabacion,
        hubo_intervencion_del_agente: primeraDelAgente !== undefined,
        criterio: 'bloqueante',
      },
      call.conversationId,
    );
  }

  // --- 3. Cierre de la llamada -------------------------------------------
  const estado = mapearEstadoFinal(payload.data.status, call.callStatus);
  const duracion = duracionDelPayload(payload);
  const finalizadaEn =
    payload.event_timestamp !== undefined ? new Date(payload.event_timestamp * 1000) : ahora;

  try {
    await deps.calls.update(call.id, {
      callStatus: estado,
      finalizadaEn,
      ...(duracion !== undefined ? { voiceDurationS: Math.round(duracion) } : {}),
    });
  } catch (err) {
    deps.logger.error(
      { callId: call.id, error: err instanceof Error ? err.message : String(err) },
      'webhook post-llamada: no se pudo consolidar el estado final de la llamada',
    );
  }

  await registrarEvento(deps, call.id, {
    origen: 'webhook_post_llamada',
    estado,
    disclosure_ejecutada: revision.cumple,
  });

  return {
    tipo: 'transcripcion',
    callId: call.id,
    disclosureCumple: revision.cumple,
    reconciliacion,
  };
}

/** Llamada que ni siquiera llego a establecerse: `busy`, `no-answer` o `unknown`. */
async function procesarFalloDeInicio(
  deps: PostCallDeps,
  payload: PostCallWebhookPayload,
  call: CallRecord | null,
  ahora: Date,
): Promise<ResultadoPostLlamada> {
  const motivo = normalizarMotivoDeFallo(payload.data.failure_reason);
  const finalizadaEn =
    payload.event_timestamp !== undefined ? new Date(payload.event_timestamp * 1000) : ahora;

  deps.logger.warn(
    { callId: call?.id, motivo },
    'webhook post-llamada: la llamada no llego a iniciarse',
  );

  if (call) {
    try {
      // `voice_duration_s = 0`: no hubo conversacion. Y NO se toca
      // `disclosure_ejecutada`: una llamada que no se establecio no pudo
      // ejecutar la revelacion, y marcarla inflaria el porcentaje de
      // cumplimiento con llamadas que nunca ocurrieron.
      await deps.calls.update(call.id, { callStatus: 'fallida', finalizadaEn, voiceDurationS: 0 });
    } catch (err) {
      deps.logger.error(
        { callId: call.id, error: err instanceof Error ? err.message : String(err) },
        'webhook post-llamada: no se pudo marcar la llamada como fallida',
      );
    }
    await registrarEvento(deps, call.id, { origen: 'fallo_de_inicio', failure_reason: motivo });
  }

  await auditar(
    deps,
    'llamada_no_iniciada',
    {
      call_id: call?.id ?? null,
      failure_reason: motivo,
      failure_reason_crudo: payload.data.failure_reason ?? null,
    },
    call?.conversationId,
  );

  const resultado: ResultadoPostLlamada = { tipo: 'fallo_de_inicio' };
  if (call) resultado.callId = call.id;
  else resultado.motivo = 'llamada_no_encontrada';
  return resultado;
}

/**
 * Procesa un payload post-llamada ya autenticado.
 *
 * Se exporta aparte de la ruta para poder probarla de punta a punta sin
 * depender de cuanto tarda en asentarse el trabajo que la ruta arranca DESPUES
 * de responder 200. Nunca lanza.
 */
export async function handlePostCallWebhookEvent(
  rawPayload: unknown,
  deps: PostCallDeps,
): Promise<ResultadoPostLlamada> {
  const ahora = (deps.now ?? (() => new Date()))();

  const parsed = postCallWebhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    deps.logger.warn({}, 'webhook post-llamada: payload con forma inesperada, se ignora');
    return { tipo: 'desconocido', motivo: 'payload_invalido' };
  }
  const payload = parsed.data;
  const tipo = clasificarPayload(payload);

  if (tipo === 'desconocido') {
    deps.logger.warn(
      { tipoDeclarado: payload.type },
      'webhook post-llamada: tipo de evento no reconocido, se ignora',
    );
    return { tipo, motivo: 'tipo_no_reconocido' };
  }

  const call = await resolverLlamada(deps, payload);

  // El audio se descarta llegue o no a resolverse la llamada: la politica de
  // retencion no depende de que encontremos la fila.
  if (tipo === 'audio') return descartarAudio(deps, payload, call);
  if (tipo === 'fallo_de_inicio') return procesarFalloDeInicio(deps, payload, call, ahora);

  if (!call) {
    deps.logger.warn(
      {},
      'webhook post-llamada: no hay fila en `calls` para esta conversacion; no se consolida nada',
    );
    return { tipo, motivo: 'llamada_no_encontrada' };
  }

  return procesarTranscripcion(deps, payload, call, ahora);
}

// ---------------------------------------------------------------------------
// Plugin Fastify
// ---------------------------------------------------------------------------

function registrarParserDeCuerpoCrudo(app: FastifyInstance): void {
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
      done(new Error('webhook post-llamada: cuerpo no es JSON valido'), undefined);
    }
  });
}

function cabecera(valor: string | string[] | undefined): string | undefined {
  if (valor === undefined) return undefined;
  return Array.isArray(valor) ? valor[0] : valor;
}

export const postCallWebhookPlugin: FastifyPluginAsync<PostCallDeps> = async (app, deps) => {
  if (deps.webhookSecret === '') {
    // Falla cerrado, pero ruidoso: sin secreto este endpoint rechaza todos los
    // webhooks reales y la transcripcion nunca se consolidaria en silencio.
    deps.logger.fatal(
      {},
      'webhook post-llamada registrado sin ELEVENLABS_WEBHOOK_SECRET: TODAS las peticiones seran rechazadas con 401',
    );
  }

  registrarParserDeCuerpoCrudo(app);

  const opciones = deps.bodyLimitBytes !== undefined ? { bodyLimit: deps.bodyLimitBytes } : {};

  app.post(RUTA_WEBHOOK_POST_LLAMADA, opciones, async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = request.rawBody ?? '';
    const firma = cabecera(request.headers['elevenlabs-signature']);

    // FALLA CERRADO ANTES DE VERIFICAR. `verifyElevenLabsWebhookSignature` NO
    // rechaza por si sola un secreto vacio: `createHmac('sha256', '')` es un
    // HMAC perfectamente valido, asi que cualquiera que sepa que el despliegue
    // se quedo sin `ELEVENLABS_WEBHOOK_SECRET` podria firmar sus propios
    // webhooks. `ElevenLabsClient.verifyWebhookSignature` si tiene esa guarda;
    // la funcion suelta, no. Se replica aqui -mismo criterio que `autenticar()`
    // del gateway- y queda declarado en el informe como hueco de
    // `src/infra/elevenlabs.client.ts`.
    if (deps.webhookSecret === '') {
      deps.logger.warn({}, 'webhook post-llamada: sin secreto configurado, se rechaza con 401');
      return reply.status(401).send();
    }

    const verificacion = verifyElevenLabsWebhookSignature(rawBody, firma, deps.webhookSecret, {
      ...(deps.toleranceSeconds !== undefined ? { toleranceSeconds: deps.toleranceSeconds } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });

    if (!verificacion.valid) {
      // Nada se procesa: ni transcripcion, ni audio, ni cierre de llamada. Un
      // payload sin firma valida no es evidencia de nada.
      deps.logger.warn(
        { motivo: verificacion.reason },
        'webhook post-llamada: firma invalida, se rechaza sin procesar',
      );
      return reply.status(401).send();
    }

    reply.status(200).send({ received: true });

    void handlePostCallWebhookEvent(request.body, deps).catch((err: unknown) => {
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'webhook post-llamada: error inesperado procesando el payload tras el ACK',
      );
    });
    return;
  });
};
