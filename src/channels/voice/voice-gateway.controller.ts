/**
 * voice-gateway.controller.ts
 *
 * EL COMPONENTE CRITICO (§5 de la especificacion). Endpoint Custom LLM al que
 * ElevenLabs manda peticiones con forma OpenAI.
 *
 * **El gateway traduce y nada mas** (anti-patron 2). Aqui no hay ni una sola
 * decision de negocio: que responder, cuando escalar, si hay urgencia, si el
 * precio se puede cerrar... todo eso lo decide el `ConversationService`, que es
 * EXACTAMENTE el mismo objeto que usa WhatsApp. Este archivo:
 *   1. autentica,
 *   2. extrae contexto de `elevenlabs_extra_body`,
 *   3. toma el ULTIMO mensaje de usuario (el historial autoritativo es nuestra
 *      base, no el array que manda ElevenLabs -- anti-patron 6),
 *   4. invoca `streamTurn()` con `channel: 'voice'`,
 *   5. traduce cada `TurnChunk` a SSE con forma OpenAI,
 *   6. persiste metricas y eventos de la llamada.
 *
 * RUTAS (relativas al prefijo con el que se registre el plugin; con prefijo
 * vacio quedan tal cual las pide la especificacion):
 *   POST /v1/chat/completions
 *   POST /v1/g/:secret/chat/completions      <- secreto en la ruta, ver abajo
 *
 * ---------------------------------------------------------------------------
 * AUTENTICACION POR TRES VIAS (docs/contrato-elevenlabs.md §2)
 * ---------------------------------------------------------------------------
 * La documentacion oficial NO especifica ningun header de autenticacion que
 * ElevenLabs envie a nuestro endpoint. La especificacion asume «secreto
 * compartido en header» y la Fase 4 exige que una peticion sin secreto devuelva
 * 401. Se aceptan las tres vias a la vez y se rechaza con 401 si ninguna
 * coincide:
 *   1. `Authorization: Bearer <VOICE_GATEWAY_SECRET>`  (lo mas probable, por
 *      ser una interfaz OpenAI);
 *   2. `x-gateway-secret: <VOICE_GATEWAY_SECRET>`;
 *   3. segmento secreto en la ruta.
 * La via 3 es la unica que funciona con CERTEZA aunque el proveedor no mande
 * header alguno, porque la URL del Custom LLM si la configuramos nosotros. Es
 * lo que hace que el control exista de verdad y no sobre el papel.
 *
 * ---------------------------------------------------------------------------
 * NUNCA UN 500 SECO (anti-patron 7)
 * ---------------------------------------------------------------------------
 * El silencio en una llamada es el peor modo de fallo. Superada la
 * autenticacion, este endpoint responde SIEMPRE 200 con un SSE valido: si algo
 * falla, emite un mensaje de respaldo HABLABLE y dispara `transfer_to_number`.
 * El unico codigo distinto de 200 que devuelve es el 401.
 */
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  MENSAJE_DE_FALLO_TECNICO,
} from '../../core/conversation/conversation.service.js';
import type {
  ClinicRepository,
  ConversationService,
  EscalationRequest,
  InboundMessage,
  Logger,
  OutboundMessage,
} from '../../core/types/index.js';
import {
  SSE_DONE,
  chunkDeCierre,
  chunkDeTexto,
  crearIdDeCompletion,
  lineasDeToolCall,
  serializarChunk,
} from './openai-sse.mapper.js';
import {
  argumentosJson,
  mapearEscalacion,
  mapearFinDeLlamada,
  mapearToolCallDeSistema,
  type SystemToolInvocation,
} from './system-tools.mapper.js';
import type { VoiceSessionService, ContextoDeSesionDeVoz } from './voice-session.service.js';
import {
  ultimoMensajeDeUsuario,
  voiceChatCompletionRequestSchema,
  type ContextoDeChunk,
} from './voice.types.js';

// ---------------------------------------------------------------------------
// Textos canonicos del adaptador
// ---------------------------------------------------------------------------

/**
 * Expresion puente ante latencia (§5, paso 7).
 *
 * TERMINA EN «... » -- elipsis MAS ESPACIO. El espacio es OBLIGATORIO: sin el,
 * el sintetizador pega el puente con la primera palabra real y distorsiona el
 * audio. Hay un test que lo comprueba.
 *
 * Que esto se emita NO es una solucion: es la senal de que el primer token
 * tarda demasiado y hay que optimizar. Por eso se registra ademas como evento
 * de audio de tipo `silencio`.
 */
export const TEXTO_PUENTE = 'Un momento, por favor... ';

/** Modelo que se declara en los chunks si el request no trae uno. */
export const MODELO_POR_DEFECTO = 'recepcion-ia-voice';

/** Resumen para la persona que recibe una llamada derivada por fallo tecnico. */
const RESUMEN_DE_FALLO_TECNICO =
  'Fallo tecnico del asistente virtual durante la llamada. El paciente esta en linea y no recibio ' +
  'respuesta del asistente. Requiere atencion humana desde el principio de la consulta.';

// ---------------------------------------------------------------------------
// Autenticacion
// ---------------------------------------------------------------------------

export type ViaDeAutenticacion = 'authorization_bearer' | 'x_gateway_secret' | 'segmento_de_ruta';

export interface ResultadoDeAutenticacion {
  ok: boolean;
  via?: ViaDeAutenticacion;
}

/**
 * Comparacion en tiempo constante.
 *
 * `timingSafeEqual` exige buffers del mismo tamano. Cuando difieren se compara
 * el buffer consigo mismo (para no cortocircuitar mas rapido de lo normal) y se
 * devuelve `false`. LIMITACION ACEPTADA Y DECLARADA: la longitud del secreto
 * sigue siendo observable por temporizacion; el contenido no. Ocultar tambien
 * la longitud exigiria comparar contra un HMAC de longitud fija, que para un
 * secreto de despliegue no compensa.
 */
export function comparacionSegura(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extrae el token de un header `Authorization: Bearer <token>`. */
export function tokenDeBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const prefijo = 'bearer ';
  if (authorization.length <= prefijo.length) return undefined;
  if (authorization.slice(0, prefijo.length).toLowerCase() !== prefijo) return undefined;
  const token = authorization.slice(prefijo.length).trim();
  return token === '' ? undefined : token;
}

export interface CredencialesEntrantes {
  authorization?: string;
  gatewaySecretHeader?: string;
  secretoDeRuta?: string;
}

/**
 * Las TRES vias del §2 del contrato del proveedor. Si el secreto esperado esta
 * vacio, se rechaza SIEMPRE: un despliegue sin `VOICE_GATEWAY_SECRET` no puede
 * degradar a «endpoint abierto» (falla cerrado).
 */
export function autenticar(
  credenciales: CredencialesEntrantes,
  secretoEsperado: string,
): ResultadoDeAutenticacion {
  if (secretoEsperado === '') return { ok: false };

  const bearer = tokenDeBearer(credenciales.authorization);
  if (bearer !== undefined && comparacionSegura(bearer, secretoEsperado)) {
    return { ok: true, via: 'authorization_bearer' };
  }
  if (
    credenciales.gatewaySecretHeader !== undefined &&
    comparacionSegura(credenciales.gatewaySecretHeader, secretoEsperado)
  ) {
    return { ok: true, via: 'x_gateway_secret' };
  }
  if (
    credenciales.secretoDeRuta !== undefined &&
    comparacionSegura(credenciales.secretoDeRuta, secretoEsperado)
  ) {
    return { ok: true, via: 'segmento_de_ruta' };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export interface VoiceGatewayDeps {
  /** NUNCA se instancia aqui: es el MISMO servicio que usa WhatsApp. */
  conversationService: ConversationService;
  /** Solo para leer `transferWhitelist`. La validacion del numero es del mapper. */
  clinics: ClinicRepository;
  sessions: VoiceSessionService;
  logger: Logger;
  /** `config.VOICE_GATEWAY_SECRET`. Vacio = el endpoint rechaza todo. */
  gatewaySecret: string;
  /** `config.VOICE_BUFFER_WORD_MS`. Umbral del puente ante latencia. */
  bufferWordMs: number;
  /** Se declara en los chunks si el request no trae `model`. */
  modeloPorDefecto?: string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

function cabecera(valor: string | string[] | undefined): string | undefined {
  if (valor === undefined) return undefined;
  return Array.isArray(valor) ? valor[0] : valor;
}

/**
 * `true` si paso `ms` sin que `pendiente` se resolviera. No consume la promesa:
 * quien llama sigue haciendo su `await` normal despues.
 */
async function seAgotoLaEspera(pendiente: Promise<unknown>, ms: number): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) return false;
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const espera = new Promise<'agotado'>((resolver) => {
    temporizador = setTimeout(() => resolver('agotado'), ms);
  });
  // Un rechazo se gestiona en el `await` real de mas abajo; aqui solo importa
  // si llego ALGO antes del umbral.
  const llegada = pendiente.then(
    () => 'llego' as const,
    () => 'llego' as const,
  );
  const ganador = await Promise.race([llegada, espera]);
  if (temporizador !== undefined) clearTimeout(temporizador);
  return ganador === 'agotado';
}

// ---------------------------------------------------------------------------
// Generacion del SSE
// ---------------------------------------------------------------------------

interface ParametrosDeTurno {
  chunkCtx: ContextoDeChunk;
  contexto: ContextoDeSesionDeVoz;
  texto: string;
  transferWhitelist: readonly string[];
  recibidoEn: Date;
}

/**
 * Emisor de tool calls con indice propio.
 *
 * `index` es la posicion dentro de `tool_calls[]` del mensaje que se esta
 * componiendo; OpenAI lo usa para reensamblar fragmentos de varias llamadas.
 */
class EmisorDeToolCalls {
  private indice = 0;
  emitidos = 0;

  constructor(private readonly chunkCtx: ContextoDeChunk) {}

  lineas(invocacion: SystemToolInvocation): string[] {
    const lineas = lineasDeToolCall(this.chunkCtx, {
      index: this.indice,
      name: invocacion.name,
      argumentsJson: argumentosJson(invocacion),
    });
    this.indice += 1;
    this.emitidos += 1;
    return lineas;
  }
}

/**
 * SSE del turno completo. Nunca lanza: cualquier fallo se convierte en el
 * mensaje de respaldo hablable mas la transferencia a una persona.
 */
async function* generarTurno(
  deps: VoiceGatewayDeps,
  params: ParametrosDeTurno,
): AsyncGenerator<string> {
  const { chunkCtx, contexto, texto, transferWhitelist, recibidoEn } = params;
  const log = deps.logger.child({
    componente: 'voice-gateway',
    clinicId: contexto.clinicId,
    sessionId: contexto.sessionId,
    turno: contexto.turno,
  });

  const inicio = Date.now();
  const emisor = new EmisorDeToolCalls(chunkCtx);
  const pendientesDePersistir: Array<Promise<void>> = [];

  let textoEmitido = '';
  let esperandoPrimerTexto = true;
  let puenteEmitido = false;
  let finDelStream = inicio;

  const inbound: InboundMessage = {
    clinicId: contexto.clinicId,
    patientPhoneE164: contexto.patientPhoneE164,
    text: texto,
    channel: 'voice',
    receivedAt: recibidoEn,
  };
  if (contexto.sessionId !== undefined) inbound.sessionId = contexto.sessionId;

  const callId = contexto.call?.id;

  /** Transferencia: emite el tool call y deja rastro. */
  function* emitirTransferencia(request: EscalationRequest): Generator<string> {
    const resultado = mapearEscalacion(request, transferWhitelist);
    if (!resultado.ok) {
      // Sin transferencia telefonica posible, el escalamiento NO se pierde: la
      // herramienta `escalar_humano` del nucleo ya notifico a recepcion por el
      // canal de respaldo (control O5). Aqui solo se deja constancia.
      log.warn(
        { motivo: resultado.motivo, razon: request.reason },
        'no se emite transfer_to_number: el numero no supera la lista blanca',
      );
      return;
    }
    const numero = resultado.invocacion.args.transfer_number;
    yield* emisor.lineas(resultado.invocacion);
    if (callId !== undefined) {
      pendientesDePersistir.push(
        deps.sessions.registrarEvento(callId, 'transferencia', { motivo: request.reason }),
        deps.sessions.marcarTransferida(callId, numero),
      );
    }
  }

  try {
    try {
      const iterador = deps.conversationService.streamTurn(inbound)[Symbol.asyncIterator]();
      let final: OutboundMessage | undefined;

      try {
        for (;;) {
          const pendiente = iterador.next();

          // BUFFER WORD (§5, paso 7). Se mide desde el inicio del turno y solo
          // hasta el PRIMER fragmento de texto: un `tool_call` no produce audio,
          // asi que el silencio percibido por el paciente sigue corriendo.
          if (esperandoPrimerTexto && !puenteEmitido) {
            const restante = deps.bufferWordMs - (Date.now() - inicio);
            if (await seAgotoLaEspera(pendiente, restante)) {
              puenteEmitido = true;
              textoEmitido += TEXTO_PUENTE;
              log.warn(
                { umbralMs: deps.bufferWordMs },
                'buffer word emitido: el primer token supero el umbral. Es senal de que hay que optimizar, no una solucion',
              );
              if (callId !== undefined) {
                pendientesDePersistir.push(
                  deps.sessions.registrarEvento(callId, 'silencio', {
                    motivo: 'buffer_word',
                    umbral_ms: deps.bufferWordMs,
                  }),
                );
              }
              yield serializarChunk(chunkDeTexto(chunkCtx, TEXTO_PUENTE));
            }
          }

          const paso = await pendiente;
          if (paso.done === true) break;
          const chunk = paso.value;

          if (chunk.type === 'text') {
            esperandoPrimerTexto = false;
            textoEmitido += chunk.delta;
            yield serializarChunk(chunkDeTexto(chunkCtx, chunk.delta));
            continue;
          }

          if (chunk.type === 'tool_call') {
            const invocacion = mapearToolCallDeSistema(chunk.name, chunk.args);
            if (!invocacion) {
              // Herramienta de NEGOCIO (o de sistema con argumentos invalidos):
              // se ejecuta DENTRO del nucleo y no se expone a ElevenLabs
              // (anti-patron 3). Por SSE sale unicamente el texto final.
              log.debug({ herramienta: chunk.name }, 'tool call no expuesta a la telefonia');
              continue;
            }
            yield* emisor.lineas(invocacion);
            continue;
          }

          if (chunk.type === 'escalate') {
            yield* emitirTransferencia(chunk.request);
            continue;
          }

          final = chunk.message;
        }
      } finally {
        await iterador.return?.(undefined);
      }

      finDelStream = Date.now();

      if (final?.endCall === true) {
        const invocacion = mapearFinDeLlamada();
        yield* emisor.lineas(invocacion);
        if (callId !== undefined) {
          pendientesDePersistir.push(deps.sessions.registrarEvento(callId, 'fin', { origen: 'end_call' }));
        }
      }

      yield serializarChunk(chunkDeCierre(chunkCtx, emisor.emitidos > 0 ? 'tool_calls' : 'stop'));
      yield SSE_DONE;
    } catch (err) {
      // ANTI-PATRON 7. Nada de 500 ni de stream cortado: mensaje hablable y
      // derivacion a una persona. `streamTurn` ya gestiona sus propios fallos
      // internos; lo que llega aqui es lo que ocurre ANTES o ALREDEDOR de el
      // (p. ej. el router no encuentra la clinica y no hay conversationId).
      finDelStream = Date.now();
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'fallo el turno de voz; se emite respuesta de respaldo y se deriva a una persona',
      );

      const separador = textoEmitido === '' || textoEmitido.endsWith(' ') ? '' : ' ';
      textoEmitido += separador + MENSAJE_DE_FALLO_TECNICO;
      yield serializarChunk(chunkDeTexto(chunkCtx, separador + MENSAJE_DE_FALLO_TECNICO));

      /**
       * VACIO DE LA ESPECIFICACION, ya declarado por el nucleo: `EscalationReason`
       * es un enum cerrado sin valor para «fallo tecnico». Se usa
       * `fallo_comprension`, el mas cercano, igual que hace
       * `conversation.service.ts`. No se anade un valor a un contrato congelado.
       */
      const request: EscalationRequest = {
        reason: 'fallo_comprension',
        priority: 'urgente',
        summaryForAgent: RESUMEN_DE_FALLO_TECNICO,
        messageForPatient: MENSAJE_DE_FALLO_TECNICO,
      };
      yield* emitirTransferencia(request);

      yield serializarChunk(chunkDeCierre(chunkCtx, emisor.emitidos > 0 ? 'tool_calls' : 'stop'));
      yield SSE_DONE;
    }
  } finally {
    // §5, paso 8. El turno en `messages` NO se persiste aqui: ya lo hace el
    // `ConversationService` (mensaje del paciente y respuesta del asistente),
    // que es la fuente de verdad del historial. Duplicarlo desde el adaptador
    // partiria el historial en dos y volveria a meter negocio en el canal.
    const ahora = Date.now();
    pendientesDePersistir.push(
      deps.sessions.registrarCierreDeTurno({
        ...(contexto.call ? { call: contexto.call } : {}),
        turno: contexto.turno,
        textoDelPaciente: texto,
        textoDelAgente: textoEmitido,
        llmMs: finDelStream - inicio,
        totalMs: ahora - inicio,
      }),
    );
    await Promise.all(pendientesDePersistir);
  }
}

/**
 * SSE de respaldo cuando el turno no llega ni a construirse (falta contexto,
 * cuerpo ilegible, clinica desconocida). Mismo compromiso: voz + derivacion,
 * jamas silencio.
 */
async function* generarRespaldo(
  deps: VoiceGatewayDeps,
  chunkCtx: ContextoDeChunk,
  transferWhitelist: readonly string[],
  motivo: string,
): AsyncGenerator<string> {
  deps.logger.warn({ motivo }, 'turno de voz sin contexto utilizable; se emite respuesta de respaldo');

  const emisor = new EmisorDeToolCalls(chunkCtx);
  yield serializarChunk(chunkDeTexto(chunkCtx, MENSAJE_DE_FALLO_TECNICO));

  const resultado = mapearEscalacion(
    {
      reason: 'fallo_comprension',
      priority: 'urgente',
      summaryForAgent: `${RESUMEN_DE_FALLO_TECNICO} Motivo tecnico: ${motivo}.`,
      messageForPatient: MENSAJE_DE_FALLO_TECNICO,
    },
    transferWhitelist,
  );
  if (resultado.ok) {
    yield* emisor.lineas(resultado.invocacion);
  }

  yield serializarChunk(chunkDeCierre(chunkCtx, emisor.emitidos > 0 ? 'tool_calls' : 'stop'));
  yield SSE_DONE;
}

/** Turno sin mensaje de usuario: no hay nada que traducir, y el agente no debe hablar. */
async function* generarTurnoVacio(chunkCtx: ContextoDeChunk): AsyncGenerator<string> {
  yield serializarChunk(chunkDeCierre(chunkCtx, 'stop'));
  yield SSE_DONE;
}

// ---------------------------------------------------------------------------
// Ruta
// ---------------------------------------------------------------------------

function responderSse(reply: FastifyReply, generador: AsyncGenerator<string>): FastifyReply {
  return reply
    .status(200)
    .header('content-type', 'text/event-stream')
    .header('cache-control', 'no-cache, no-transform')
    .header('connection', 'keep-alive')
    // `x-accel-buffering` desactiva el buffering de nginx: sin esto un proxy
    // puede retener los chunks y anular el streaming, que es justo lo que hace
    // tolerable la latencia en una llamada.
    .header('x-accel-buffering', 'no')
    .send(Readable.from(generador, { objectMode: false }));
}

async function manejarChatCompletions(
  deps: VoiceGatewayDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const params = request.params as { secret?: string } | undefined;
  const credenciales: CredencialesEntrantes = {};
  const authorization = cabecera(request.headers.authorization);
  const gatewaySecretHeader = cabecera(request.headers['x-gateway-secret']);
  if (authorization !== undefined) credenciales.authorization = authorization;
  if (gatewaySecretHeader !== undefined) credenciales.gatewaySecretHeader = gatewaySecretHeader;
  if (params?.secret !== undefined) credenciales.secretoDeRuta = params.secret;

  const auth = autenticar(credenciales, deps.gatewaySecret);
  if (!auth.ok) {
    deps.logger.warn({}, 'voice gateway: peticion sin secreto valido, se rechaza con 401');
    return reply.status(401).send({
      error: {
        message: 'credenciales del gateway invalidas o ausentes',
        type: 'invalid_request_error',
        code: 'unauthorized',
      },
    });
  }

  const ahora = (deps.now ?? (() => new Date()))();
  const parsed = voiceChatCompletionRequestSchema.safeParse(request.body);
  const chunkCtx: ContextoDeChunk = {
    id: crearIdDeCompletion(),
    model: (parsed.success ? parsed.data.model : undefined) ?? deps.modeloPorDefecto ?? MODELO_POR_DEFECTO,
    created: Math.floor(ahora.getTime() / 1000),
  };

  if (!parsed.success) {
    return responderSse(reply, generarRespaldo(deps, chunkCtx, [], 'cuerpo_no_valido'));
  }

  const cuerpo = parsed.data;
  const resolucion = await deps.sessions.resolverContexto(cuerpo.elevenlabs_extra_body);
  if (!resolucion.ok) {
    return responderSse(reply, generarRespaldo(deps, chunkCtx, [], resolucion.motivo));
  }
  const contexto = resolucion.contexto;

  // La lista blanca se lee de la clinica, nunca del request: un `transfer_number`
  // que llegara por la red no seria de fiar (anti-patron 4).
  let transferWhitelist: readonly string[] = [];
  try {
    const clinica = await deps.clinics.findById(contexto.clinicId);
    transferWhitelist = clinica?.transferWhitelist ?? [];
  } catch (err) {
    deps.logger.error(
      { clinicId: contexto.clinicId, error: String(err) },
      'no se pudo leer la lista blanca de transferencia de la clinica',
    );
  }

  if (contexto.turno === 1 && contexto.call) {
    // Revelacion obligatoria (§7): se comprueba, no se da por hecha.
    await deps.sessions.verificarDisclosure(contexto.call);
  }

  const texto = ultimoMensajeDeUsuario(cuerpo.messages);
  if (texto === undefined) {
    deps.logger.info(
      { sessionId: contexto.sessionId },
      'voice gateway: request sin mensaje de usuario; se cierra el turno sin emitir audio',
    );
    return responderSse(reply, generarTurnoVacio(chunkCtx));
  }

  return responderSse(
    reply,
    generarTurno(deps, { chunkCtx, contexto, texto, transferWhitelist, recibidoEn: ahora }),
  );
}

/**
 * Plugin Fastify del gateway de voz.
 *
 * Se registra con las dependencias ya construidas
 * (`app.register(voiceGatewayPlugin, { conversationService, ... })`), igual que
 * el plugin de WhatsApp. Nada se instancia dentro.
 */
export const voiceGatewayPlugin: FastifyPluginAsync<VoiceGatewayDeps> = async (app, deps) => {
  if (deps.gatewaySecret === '') {
    // Falla cerrado, pero ruidoso: un endpoint de voz sin secreto rechazaria
    // todas las llamadas reales y eso tiene que verse en el arranque.
    deps.logger.fatal(
      {},
      'voice gateway registrado sin VOICE_GATEWAY_SECRET: TODAS las peticiones seran rechazadas con 401',
    );
  }

  const manejador = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    manejarChatCompletions(deps, request, reply);

  app.post('/v1/chat/completions', manejador);
  // Via 3 del §2: el secreto viaja en la ruta. Es la unica que funciona con
  // certeza si el proveedor no envia ningun header.
  app.post('/v1/g/:secret/chat/completions', manejador);
};
