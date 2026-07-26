/**
 * CRITERIOS DE ACEPTACION DE LA FASE 4.
 *
 *   · un cuerpo estilo OpenAI devuelve SSE valido que TERMINA en `data: [DONE]`;
 *   · una `EscalationRequest` produce un `tool_call` de `transfer_to_number`
 *     con `agent_message` no vacio y `transfer_number` en la lista blanca;
 *   · peticion sin secreto -> 401, probando las TRES vias de autenticacion.
 *
 * Ademas se cubre lo que hace que el gateway sea aceptable en una llamada real:
 * que NUNCA devuelva un 500 seco (anti-patron 7), que las herramientas de
 * negocio no se filtren a la telefonia (anti-patron 3), que el historial
 * autoritativo sea el nuestro (anti-patron 6) y que el buffer word termine en
 * elipsis MAS espacio.
 *
 * Sin red y sin credenciales: el nucleo es el REAL (`crearEntornoDePrueba`
 * monta ConversationService, PromptBuilder, guardrails, urgencia y las cinco
 * herramientas de verdad) y solo la frontera esta doblada. El unico servicio
 * simulado es el propio ConversationService en los casos donde hace falta
 * forzar un fallo o una latencia concreta.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  voiceGatewayPlugin,
  autenticar,
  comparacionSegura,
  tokenDeBearer,
  TEXTO_PUENTE,
  type VoiceGatewayDeps,
} from '../../src/channels/voice/voice-gateway.controller.js';
import { VoiceSessionService } from '../../src/channels/voice/voice-session.service.js';
import type {
  ActualizacionDeLlamada,
  AudioEvent,
  CallRecord,
  CallRepository,
  LatencyMetric,
  NuevaLatencyMetric,
  NuevaLineaDeTranscripcion,
  NuevaLlamada,
  NuevoAudioEvent,
  OpenAiChatCompletionChunk,
  TranscriptLine,
  TranscriptRepository,
} from '../../src/channels/voice/voice.types.js';
import { SupabaseCallRepository } from '../../src/infra/repositories/call.repository.js';
import { SupabaseTranscriptRepository } from '../../src/infra/repositories/transcript.repository.js';
import { MENSAJE_DE_FALLO_TECNICO } from '../../src/core/conversation/conversation.service.js';
import type {
  ClinicRepository,
  ConversationService,
  TurnChunk,
} from '../../src/core/types/index.js';
import {
  CLINICA_DE_PRUEBA,
  LoggerDoble,
  crearEntornoDePrueba,
  type EntornoDePrueba,
} from '../helpers/dobles.js';

const SECRETO = 'secreto-del-gateway-de-voz';
const SESSION_ID = 'sess-abc-123';
const TELEFONO = '+51987654321';
const NUMERO_EN_LISTA_BLANCA = CLINICA_DE_PRUEBA.transferWhitelist[0] as string;

// ---------------------------------------------------------------------------
// Dobles de persistencia del canal de voz
// ---------------------------------------------------------------------------

let secuencia = 0;
const nuevoId = (prefijo: string): string => {
  secuencia += 1;
  return `${prefijo}-${secuencia}`;
};

class CallRepositoryDoble implements CallRepository {
  readonly llamadas: CallRecord[] = [];
  readonly eventos: AudioEvent[] = [];
  readonly latencias: LatencyMetric[] = [];
  readonly disclosuresMarcadas: string[] = [];

  sembrar(over: Partial<CallRecord> = {}): CallRecord {
    const call: CallRecord = {
      id: nuevoId('call'),
      conversationId: nuevoId('conv'),
      sessionId: SESSION_ID,
      callStatus: 'en_curso',
      iniciadaEn: new Date('2026-07-25T10:00:00Z'),
      consentimientoGrabacion: false,
      retencionAudio: false,
      disclosureEjecutada: false,
      updatedAt: new Date('2026-07-25T10:00:00Z'),
      numeroOrigen: TELEFONO,
      ...over,
    };
    this.llamadas.push(call);
    return call;
  }

  async findBySessionId(sessionId: string): Promise<CallRecord | null> {
    return this.llamadas.find((c) => c.sessionId === sessionId) ?? null;
  }

  async findById(callId: string): Promise<CallRecord | null> {
    return this.llamadas.find((c) => c.id === callId) ?? null;
  }

  async create(nueva: NuevaLlamada): Promise<CallRecord> {
    return this.sembrar({
      conversationId: nueva.conversationId,
      sessionId: nueva.sessionId,
      callStatus: nueva.callStatus ?? 'iniciada',
      disclosureEjecutada: nueva.disclosureEjecutada ?? false,
    });
  }

  async update(callId: string, cambios: ActualizacionDeLlamada): Promise<CallRecord> {
    const call = this.llamadas.find((c) => c.id === callId);
    if (!call) throw new Error(`no existe la llamada ${callId}`);
    if (cambios.callStatus !== undefined) call.callStatus = cambios.callStatus;
    if (cambios.transferidaA) call.transferidaA = cambios.transferidaA;
    return call;
  }

  async marcarDisclosureEjecutada(callId: string): Promise<void> {
    this.disclosuresMarcadas.push(callId);
    const call = this.llamadas.find((c) => c.id === callId);
    if (call) call.disclosureEjecutada = true;
  }

  async appendAudioEvent(evento: NuevoAudioEvent): Promise<AudioEvent> {
    const fila: AudioEvent = {
      id: nuevoId('ae'),
      callId: evento.callId,
      tipo: evento.tipo,
      ts: evento.ts ?? new Date(),
      ...(evento.payload ? { payload: evento.payload } : {}),
    };
    this.eventos.push(fila);
    return fila;
  }

  async appendLatencyMetric(metrica: NuevaLatencyMetric): Promise<LatencyMetric> {
    const fila: LatencyMetric = { id: nuevoId('lm'), ...metrica };
    this.latencias.push(fila);
    return fila;
  }

  async siguienteTurno(callId: string): Promise<number> {
    return this.latencias.filter((l) => l.callId === callId).length + 1;
  }

  de(tipo: string): AudioEvent[] {
    return this.eventos.filter((e) => e.tipo === tipo);
  }
}

class TranscriptRepositoryDoble implements TranscriptRepository {
  readonly lineas: TranscriptLine[] = [];

  async append(linea: NuevaLineaDeTranscripcion): Promise<TranscriptLine> {
    const fila: TranscriptLine = { id: nuevoId('tr'), ...linea };
    this.lineas.push(fila);
    return fila;
  }

  async appendMany(lineas: readonly NuevaLineaDeTranscripcion[]): Promise<TranscriptLine[]> {
    return Promise.all(lineas.map((l) => this.append(l)));
  }

  async listByCall(callId: string): Promise<TranscriptLine[]> {
    return this.lineas.filter((l) => l.callId === callId);
  }
}

const clinicasFalsas: ClinicRepository = {
  findById: async () => CLINICA_DE_PRUEBA,
};

// ---------------------------------------------------------------------------
// Utilidades de SSE
// ---------------------------------------------------------------------------

function bloques(body: string): string[] {
  return body.split('\n\n').filter((b) => b.trim() !== '');
}

function chunks(body: string): OpenAiChatCompletionChunk[] {
  return bloques(body)
    .filter((b) => b !== 'data: [DONE]')
    .map((b) => JSON.parse(b.slice('data: '.length)) as OpenAiChatCompletionChunk);
}

function textoEmitido(body: string): string {
  return chunks(body)
    .map((c) => c.choices[0]?.delta.content ?? '')
    .join('');
}

interface ToolCallReensamblado {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Reensambla los tool calls igual que lo haria un consumidor real: agrupa por
 * `index`, toma el nombre del primer fragmento y concatena los `arguments`.
 * Si la asuncion sobre el formato de streaming fuera erronea, este ensamblado
 * es lo primero que fallaria.
 */
function toolCalls(body: string): ToolCallReensamblado[] {
  const porIndice = new Map<number, { name: string; args: string }>();
  for (const chunk of chunks(body)) {
    for (const tc of chunk.choices[0]?.delta.tool_calls ?? []) {
      const actual = porIndice.get(tc.index) ?? { name: '', args: '' };
      if (tc.function?.name) actual.name = tc.function.name;
      if (tc.function?.arguments) actual.args += tc.function.arguments;
      porIndice.set(tc.index, actual);
    }
  }
  return [...porIndice.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ name: v.name, args: JSON.parse(v.args === '' ? '{}' : v.args) as Record<string, unknown> }));
}

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

interface Montaje {
  app: FastifyInstance;
  calls: CallRepositoryDoble;
  transcripts: TranscriptRepositoryDoble;
  logger: LoggerDoble;
}

async function montar(over: Partial<VoiceGatewayDeps> = {}, calls?: CallRepositoryDoble): Promise<Montaje> {
  const logger = new LoggerDoble();
  const repoLlamadas = calls ?? new CallRepositoryDoble();
  const transcripts = new TranscriptRepositoryDoble();
  const sessions = new VoiceSessionService({
    calls: repoLlamadas,
    transcripts,
    logger,
    now: () => new Date('2026-07-25T10:05:00Z'),
  });

  const deps: VoiceGatewayDeps = {
    conversationService: servicioDeGuion(),
    clinics: clinicasFalsas,
    sessions,
    logger,
    gatewaySecret: SECRETO,
    // Alto a proposito: salvo en el test del buffer word, no debe dispararse.
    bufferWordMs: 5_000,
    ...over,
  };

  const app = Fastify();
  await app.register(voiceGatewayPlugin, deps);
  await app.ready();
  return { app, calls: repoLlamadas, transcripts, logger };
}

function servicioDeGuion(...guion: TurnChunk[]): ConversationService {
  const porDefecto: TurnChunk[] =
    guion.length > 0
      ? guion
      : [
          { type: 'text', delta: 'Con gusto.' },
          {
            type: 'done',
            message: {
              conversationId: '33333333-3333-4333-8333-333333333333',
              text: 'Con gusto.',
              channel: 'voice',
              latencyMs: 5,
            },
          },
        ];
  return {
    handleTurn: async () => {
      throw new Error('no se usa handleTurn en el canal de voz');
    },
    streamTurn: async function* () {
      for (const chunk of porDefecto) yield chunk;
    },
  };
}

function cuerpo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    stream: true,
    messages: [
      { role: 'system', content: 'ignorado: el prompt vive en el nucleo' },
      { role: 'assistant', content: 'Hola, le atiende el asistente virtual...' },
      { role: 'user', content: 'Hola, quisiera una cita para una limpieza.' },
    ],
    elevenlabs_extra_body: {
      clinic_id: CLINICA_DE_PRUEBA.id,
      session_id: SESSION_ID,
      phone: TELEFONO,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Autenticacion — criterio de aceptacion
// ---------------------------------------------------------------------------

describe('autenticacion por las TRES vias (docs/contrato-elevenlabs.md §2)', () => {
  it('sin ningun secreto -> 401, y el nucleo no llega a invocarse', async () => {
    let invocado = false;
    const servicio: ConversationService = {
      handleTurn: async () => {
        throw new Error('no');
      },
      streamTurn: async function* () {
        invocado = true;
        yield { type: 'text', delta: 'x' };
      },
    };
    const { app } = await montar({ conversationService: servicio });

    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: cuerpo() });

    expect(res.statusCode).toBe(401);
    expect(invocado).toBe(false);
    await app.close();
  });

  it('via 1: Authorization: Bearer <secreto> -> 200', async () => {
    const { app } = await montar();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('via 2: x-gateway-secret -> 200', async () => {
    const { app } = await montar();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-gateway-secret': SECRETO },
      payload: cuerpo(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('via 3: segmento secreto en la ruta -> 200 (la unica que no depende de headers)', async () => {
    const { app } = await montar();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/g/${SECRETO}/chat/completions`,
      payload: cuerpo(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('un secreto equivocado por cualquiera de las tres vias -> 401', async () => {
    const { app } = await montar();

    for (const peticion of [
      { url: '/v1/chat/completions', headers: { authorization: 'Bearer otro-secreto' } },
      { url: '/v1/chat/completions', headers: { 'x-gateway-secret': 'otro-secreto' } },
      { url: '/v1/g/otro-secreto/chat/completions', headers: {} },
      { url: '/v1/chat/completions', headers: { authorization: `Basic ${SECRETO}` } },
      { url: '/v1/chat/completions', headers: { authorization: 'Bearer ' } },
    ]) {
      const res = await app.inject({ method: 'POST', payload: cuerpo(), ...peticion });
      expect(res.statusCode, `no deberia autenticar: ${JSON.stringify(peticion)}`).toBe(401);
    }
    await app.close();
  });

  it('un gateway sin secreto configurado rechaza TODO (falla cerrado)', async () => {
    const { app, logger } = await montar({ gatewaySecret: '' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ' },
      payload: cuerpo(),
    });

    expect(res.statusCode).toBe(401);
    expect(logger.de('fatal').length).toBeGreaterThan(0);
    await app.close();
  });

  it('las piezas de autenticacion, por separado', () => {
    expect(tokenDeBearer('Bearer abc')).toBe('abc');
    expect(tokenDeBearer('bearer abc')).toBe('abc');
    expect(tokenDeBearer('Bearer')).toBeUndefined();
    expect(tokenDeBearer(undefined)).toBeUndefined();

    expect(comparacionSegura('abc', 'abc')).toBe(true);
    expect(comparacionSegura('abc', 'abd')).toBe(false);
    expect(comparacionSegura('abc', 'abcd')).toBe(false); // longitudes distintas, sin lanzar
    expect(comparacionSegura('', '')).toBe(true);

    expect(autenticar({}, '')).toEqual({ ok: false });
    expect(autenticar({ authorization: 'Bearer s' }, 's')).toEqual({ ok: true, via: 'authorization_bearer' });
    expect(autenticar({ gatewaySecretHeader: 's' }, 's')).toEqual({ ok: true, via: 'x_gateway_secret' });
    expect(autenticar({ secretoDeRuta: 's' }, 's')).toEqual({ ok: true, via: 'segmento_de_ruta' });
  });
});

// ---------------------------------------------------------------------------
// 2. SSE valido con el nucleo REAL
// ---------------------------------------------------------------------------

describe('SSE con forma OpenAI sobre el nucleo real', () => {
  let env: EntornoDePrueba;

  beforeEach(async () => {
    env = await crearEntornoDePrueba();
  });

  async function turno(over: Record<string, unknown> = {}, calls?: CallRepositoryDoble) {
    const montaje = await montar({ conversationService: env.servicio, clinics: env.clinicas }, calls);
    const res = await montaje.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(over),
    });
    await montaje.app.close();
    return { res, ...montaje };
  }

  it('CRITERIO: un cuerpo estilo OpenAI devuelve SSE valido que TERMINA en `data: [DONE]`', async () => {
    env.claude.responder('Con gusto. Tenemos espacio el jueves por la manana o el viernes por la tarde.');

    const { res } = await turno();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);

    const emitidos = chunks(res.body);
    expect(emitidos.length).toBeGreaterThan(0);
    for (const chunk of emitidos) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.id.startsWith('chatcmpl-')).toBe(true);
      expect(chunk.model).toBe('gpt-4o-mini'); // se devuelve el modelo que pidio ElevenLabs
      expect(chunk.choices).toHaveLength(1);
    }
    // Exactamente un chunk de cierre, y es el ultimo antes de [DONE].
    const conFinish = emitidos.filter((c) => c.choices[0]?.finish_reason !== null);
    expect(conFinish).toHaveLength(1);
    expect(conFinish[0]?.choices[0]?.finish_reason).toBe('stop');
    expect(emitidos[emitidos.length - 1]).toBe(conFinish[0]);

    expect(textoEmitido(res.body)).toContain('jueves por la manana');
  });

  it('forma LITERAL del stream completo, byte a byte (lo que de verdad viaja por el cable)', async () => {
    const montaje = await montar({
      conversationService: servicioDeGuion(
        { type: 'text', delta: 'Con gusto.' },
        {
          type: 'done',
          message: {
            conversationId: '33333333-3333-4333-8333-333333333333',
            text: 'Con gusto.',
            channel: 'voice',
            latencyMs: 5,
          },
        },
      ),
    });
    const res = await montaje.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await montaje.app.close();

    // Se normalizan las dos partes no deterministas (id y marca de tiempo).
    const normalizado = res.body
      .replace(/"id":"chatcmpl-[0-9a-f-]+"/g, '"id":"chatcmpl-X"')
      .replace(/"created":\d+/g, '"created":0');

    expect(normalizado).toBe(
      'data: {"id":"chatcmpl-X","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini",' +
        '"choices":[{"index":0,"delta":{"content":"Con gusto."},"finish_reason":null}]}\n\n' +
        'data: {"id":"chatcmpl-X","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini",' +
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    );
  });

  it('el turno se invoca con channel:voice y el sessionId de elevenlabs_extra_body', async () => {
    env.claude.responder('Con gusto.');
    await turno();

    const mensajesDeUsuario = env.mensajes.filas.filter((m) => m.rol === 'user');
    expect(mensajesDeUsuario).toHaveLength(1);
    expect(mensajesDeUsuario[0]?.canal).toBe('voice');
    expect(mensajesDeUsuario[0]?.sessionId).toBe(SESSION_ID);
  });

  it('ANTI-PATRON 6: solo se toma el ULTIMO mensaje de usuario; el historial de ElevenLabs se ignora', async () => {
    env.claude.responder('Con gusto.');

    await turno({
      messages: [
        { role: 'user', content: 'PRIMER mensaje, inventado por ElevenLabs' },
        { role: 'assistant', content: 'respuesta inventada que no esta en nuestra base' },
        { role: 'user', content: 'SEGUNDO mensaje, el del turno actual' },
      ],
    });

    const contenidos = env.mensajes.filas.filter((m) => m.rol === 'user').map((m) => m.contenido);
    expect(contenidos).toEqual(['SEGUNDO mensaje, el del turno actual']);

    // El hilo que ve el modelo se reconstruye desde NUESTRA base: el turno
    // inventado por ElevenLabs no aparece por ningun lado.
    const enviados = JSON.stringify(env.claude.llamadas[0]?.messages ?? []);
    expect(enviados).not.toContain('PRIMER mensaje');
    expect(enviados).not.toContain('respuesta inventada');
  });

  it('ANTI-PATRON 3: las herramientas de NEGOCIO no se exponen a la telefonia', async () => {
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-rag',
            name: 'consultar_rag',
            input: { consulta: 'horario de atencion' },
          },
        ],
      },
      { texto: 'Atendemos de lunes a sabado.' },
    );

    const { res } = await turno();

    expect(res.body).not.toContain('consultar_rag');
    expect(toolCalls(res.body)).toHaveLength(0);
    expect(chunks(res.body).at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(textoEmitido(res.body)).toContain('lunes a sabado');
  });

  it('sin mensaje de usuario se cierra el turno sin emitir audio', async () => {
    const { res } = await turno({ messages: [{ role: 'system', content: 'solo sistema' }] });

    expect(res.statusCode).toBe(200);
    expect(textoEmitido(res.body)).toBe('');
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(env.mensajes.filas).toHaveLength(0);
  });

  it('si falta el telefono se obtiene del registro de la llamada por session_id (§5, paso 2)', async () => {
    env.claude.responder('Con gusto.');
    const calls = new CallRepositoryDoble();
    calls.sembrar({ numeroOrigen: TELEFONO });

    const { res } = await turno(
      { elevenlabs_extra_body: { clinic_id: CLINICA_DE_PRUEBA.id, session_id: SESSION_ID } },
      calls,
    );

    expect(res.statusCode).toBe(200);
    expect(env.pacientes.filas.map((p) => p.telefonoE164)).toEqual([TELEFONO]);
  });
});

// ---------------------------------------------------------------------------
// 3. EscalationRequest -> transfer_to_number
// ---------------------------------------------------------------------------

describe('EscalationRequest -> transfer_to_number (criterio de aceptacion)', () => {
  let env: EntornoDePrueba;

  beforeEach(async () => {
    env = await crearEntornoDePrueba();
  });

  it('CRITERIO: tool_call de transfer_to_number, agent_message no vacio y numero en lista blanca', async () => {
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-esc',
            name: 'escalar_humano',
            input: {
              reason: 'peticion_humano',
              priority: 'normal',
              summaryForAgent: 'El paciente pide hablar con una persona del equipo.',
              messageForPatient: 'Claro que si. Le estoy pasando con una persona del equipo.',
              transferNumber: NUMERO_EN_LISTA_BLANCA,
            },
          },
        ],
      },
      { texto: 'Claro que si. Le estoy pasando con una persona del equipo.' },
    );

    const calls = new CallRepositoryDoble();
    calls.sembrar();
    const montaje = await montar({ conversationService: env.servicio, clinics: env.clinicas }, calls);
    const res = await montaje.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-gateway-secret': SECRETO },
      payload: cuerpo(),
    });
    await montaje.app.close();

    const emitidas = toolCalls(res.body);
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]?.name).toBe('transfer_to_number');

    const args = emitidas[0]?.args ?? {};
    expect(CLINICA_DE_PRUEBA.transferWhitelist).toContain(args['transfer_number']);
    expect(String(args['agent_message'] ?? '').trim()).not.toBe('');
    expect(args['client_message']).toBe('Claro que si. Le estoy pasando con una persona del equipo.');
    expect(args['reason']).toBe('peticion_humano');

    // El turno cierra con finish_reason `tool_calls` y sigue terminando en [DONE].
    expect(chunks(res.body).at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);

    // Queda rastro auditable en la llamada.
    expect(calls.de('transferencia')).toHaveLength(1);
    expect(calls.llamadas[0]?.callStatus).toBe('transferida');
    expect(calls.llamadas[0]?.transferidaA).toBe(NUMERO_EN_LISTA_BLANCA);
  });

  it('un numero FUERA de la lista blanca no produce transferencia (la notificacion de respaldo si)', async () => {
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-esc',
            name: 'escalar_humano',
            input: {
              reason: 'reclamo',
              priority: 'normal',
              summaryForAgent: 'Reclamo del paciente.',
              messageForPatient: 'Le paso con una persona del equipo.',
              transferNumber: '+51900000000',
            },
          },
        ],
      },
      { texto: 'Le paso con una persona del equipo.' },
    );

    const montaje = await montar({ conversationService: env.servicio, clinics: env.clinicas });
    const res = await montaje.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-gateway-secret': SECRETO },
      payload: cuerpo(),
    });
    await montaje.app.close();

    expect(res.body).not.toContain('+51900000000');
    // El escalamiento NO se pierde: la herramienta del nucleo notifico igual.
    expect(env.notificaciones.escalamientos).toHaveLength(1);
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Anti-patron 7: nunca un 500 seco
// ---------------------------------------------------------------------------

describe('errores: mensaje hablable y transferencia, jamas silencio (anti-patron 7)', () => {
  const servicioQueFalla: ConversationService = {
    handleTurn: async () => {
      throw new Error('no');
    },
    // Generador que no llega a emitir nada: reproduce el fallo ANTES del primer
    // chunk, que es el peor caso (el paciente se quedaria en silencio absoluto).
    streamTurn: async function* () {
      throw new Error('la base de datos no responde');
    },
  };

  it('si el nucleo revienta, sale 200 con mensaje de respaldo + transfer_to_number', async () => {
    const calls = new CallRepositoryDoble();
    calls.sembrar();
    const { app } = await montar({ conversationService: servicioQueFalla }, calls);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(textoEmitido(res.body)).toContain(MENSAJE_DE_FALLO_TECNICO);

    const emitidas = toolCalls(res.body);
    expect(emitidas).toHaveLength(1);
    expect(emitidas[0]?.name).toBe('transfer_to_number');
    expect(CLINICA_DE_PRUEBA.transferWhitelist).toContain(emitidas[0]?.args['transfer_number']);
    expect(String(emitidas[0]?.args['agent_message'] ?? '')).not.toBe('');
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('sin elevenlabs_extra_body util tampoco hay 500: respuesta hablable y [DONE]', async () => {
    const { app } = await montar();

    for (const extra of [
      undefined,
      {},
      { session_id: SESSION_ID },
      { clinic_id: 'no-es-un-uuid', session_id: SESSION_ID, phone: TELEFONO },
      { clinic_id: CLINICA_DE_PRUEBA.id, session_id: SESSION_ID, phone: 'no-es-un-telefono' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${SECRETO}` },
        payload: cuerpo({ elevenlabs_extra_body: extra }),
      });

      expect(res.statusCode, JSON.stringify(extra)).toBe(200);
      expect(textoEmitido(res.body)).toContain(MENSAJE_DE_FALLO_TECNICO);
      expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);
    }
    await app.close();
  });

  it('un cuerpo que no es siquiera un objeto JSON valido tampoco produce silencio', async () => {
    const { app } = await montar();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}`, 'content-type': 'application/json' },
      payload: '[1,2,3]',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Buffer word
// ---------------------------------------------------------------------------

describe('buffer word ante latencia (§5, paso 7)', () => {
  function servicioLento(msDeEspera: number): ConversationService {
    return {
      handleTurn: async () => {
        throw new Error('no');
      },
      streamTurn: async function* () {
        await new Promise((r) => setTimeout(r, msDeEspera));
        yield { type: 'text', delta: 'Con gusto, ya lo veo.' };
        yield {
          type: 'done',
          message: {
            conversationId: '33333333-3333-4333-8333-333333333333',
            text: 'Con gusto, ya lo veo.',
            channel: 'voice',
            latencyMs: msDeEspera,
          },
        };
      },
    };
  }

  it('el puente TERMINA en elipsis MAS espacio (el espacio no es cosmetico)', () => {
    expect(TEXTO_PUENTE.endsWith('... ')).toBe(true);
    expect(TEXTO_PUENTE.endsWith('...')).toBe(false);
  });

  it('si el primer token supera el umbral se emite el puente, se registra y se sigue con el texto real', async () => {
    const calls = new CallRepositoryDoble();
    calls.sembrar();
    const { app, logger } = await montar(
      { conversationService: servicioLento(80), bufferWordMs: 10 },
      calls,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    const texto = textoEmitido(res.body);
    expect(texto.startsWith(TEXTO_PUENTE)).toBe(true);
    expect(texto).toContain('Con gusto, ya lo veo.');
    expect(res.body.endsWith('data: [DONE]\n\n')).toBe(true);

    // Es senal de que hay que optimizar: queda en el log y como evento de audio.
    expect(logger.de('warn').some((l) => String(l.msg).includes('buffer word'))).toBe(true);
    const silencios = calls.de('silencio');
    expect(silencios).toHaveLength(1);
    expect(silencios[0]?.payload).toMatchObject({ motivo: 'buffer_word', umbral_ms: 10 });
  });

  it('si el primer token llega a tiempo NO se emite ningun puente', async () => {
    const calls = new CallRepositoryDoble();
    calls.sembrar();
    const { app } = await montar({ conversationService: servicioLento(0), bufferWordMs: 2_000 }, calls);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    expect(textoEmitido(res.body)).toBe('Con gusto, ya lo veo.');
    expect(calls.de('silencio')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Persistencia del turno de voz (§5, paso 8)
// ---------------------------------------------------------------------------

describe('persistencia: latency_metrics, audio_events y transcripcion', () => {
  let env: EntornoDePrueba;

  beforeEach(async () => {
    env = await crearEntornoDePrueba();
  });

  it('cada turno deja una metrica de latencia, y stt/tts quedan SIN informar', async () => {
    env.claude.responder('Con gusto.');
    const calls = new CallRepositoryDoble();
    const call = calls.sembrar();
    const { app, transcripts } = await montar(
      { conversationService: env.servicio, clinics: env.clinicas },
      calls,
    );

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    expect(calls.latencias).toHaveLength(1);
    const metrica = calls.latencias[0];
    expect(metrica?.callId).toBe(call.id);
    expect(metrica?.turno).toBe(1);
    expect(metrica?.llmMs).toBeGreaterThanOrEqual(0);
    expect(metrica?.totalMs).toBeGreaterThanOrEqual(0);
    // No se inventan: los mide ElevenLabs, no el gateway.
    expect(metrica?.sttMs).toBeUndefined();
    expect(metrica?.ttsMs).toBeUndefined();

    // Transcripcion propia del turno: paciente y agente.
    expect(transcripts.lineas.map((l) => l.hablante)).toEqual(['paciente', 'agente']);
    expect(transcripts.lineas[1]?.texto).toContain('Con gusto');
  });

  it('el turno en `messages` lo persiste el NUCLEO, no el adaptador (sin duplicados)', async () => {
    env.claude.responder('Con gusto.');
    const calls = new CallRepositoryDoble();
    calls.sembrar();
    const { app } = await montar({ conversationService: env.servicio, clinics: env.clinicas }, calls);

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    expect(env.mensajes.filas.filter((m) => m.rol === 'user')).toHaveLength(1);
    expect(env.mensajes.filas.filter((m) => m.rol === 'assistant')).toHaveLength(1);
  });

  it('DISCLOSURE: una llamada con disclosure_ejecutada=false se detecta y se registra, no se fabrica', async () => {
    env.claude.responder('Con gusto.');
    const calls = new CallRepositoryDoble();
    calls.sembrar({ disclosureEjecutada: false });
    const { app, logger } = await montar({ conversationService: env.servicio, clinics: env.clinicas }, calls);

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    // NO se marca por inferencia: eso seria fabricar evidencia de cumplimiento.
    expect(calls.disclosuresMarcadas).toHaveLength(0);
    expect(calls.de('inicio')).toHaveLength(1);
    expect(calls.de('inicio')[0]?.payload).toMatchObject({ disclosure_ejecutada: false });
    expect(logger.de('warn').some((l) => String(l.msg).includes('revelacion obligatoria'))).toBe(true);
  });

  it('sin registro en `calls` el turno se atiende igual (no se pierde la llamada por una metrica)', async () => {
    env.claude.responder('Con gusto.');
    const calls = new CallRepositoryDoble(); // sin sembrar
    const { app } = await montar({ conversationService: env.servicio, clinics: env.clinicas }, calls);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SECRETO}` },
      payload: cuerpo(),
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(textoEmitido(res.body)).toContain('Con gusto');
    expect(calls.latencias).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Repositorios de voz sobre Supabase
// ---------------------------------------------------------------------------

type Fila = Record<string, unknown>;

interface ResultadoFalso {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

/** Doble minimo del query builder de supabase-js: filtra de verdad, no solo registra. */
class QueryBuilderFalso implements PromiseLike<ResultadoFalso> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Fila | Fila[] | undefined;
  private readonly filtros: Array<(f: Fila) => boolean> = [];
  private orden: { col: string; asc: boolean } | undefined;
  private modo: 'single' | 'maybeSingle' | undefined;
  private contar = false;
  private soloCabecera = false;

  constructor(
    private readonly tabla: string,
    private readonly store: Map<string, Fila[]>,
    private readonly errores: Map<string, string>,
    private readonly seq: { n: number },
  ) {}

  select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }): this {
    if (opts?.count) this.contar = true;
    if (opts?.head) this.soloCabecera = true;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filtros.push((f) => f[col] === val);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orden = { col, asc: opts?.ascending ?? true };
    return this;
  }
  insert(payload: Fila | Fila[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Fila): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  single(): this {
    this.modo = 'single';
    return this;
  }
  maybeSingle(): this {
    this.modo = 'maybeSingle';
    return this;
  }

  then<A = ResultadoFalso, B = never>(
    ok?: ((v: ResultadoFalso) => A | PromiseLike<A>) | null,
    fallo?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve(this.ejecutar()).then(ok, fallo);
  }

  private filas(): Fila[] {
    let filas = this.store.get(this.tabla);
    if (!filas) {
      filas = [];
      this.store.set(this.tabla, filas);
    }
    return filas;
  }

  private ejecutar(): ResultadoFalso {
    const forzado = this.errores.get(this.tabla);
    if (forzado) return { data: null, error: { message: forzado } };

    const filas = this.filas();

    if (this.op === 'insert') {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload as Fila]).map((item) => {
        this.seq.n += 1;
        return {
          id: `id-${this.seq.n}`,
          iniciada_en: '2026-07-25T10:00:00.000Z',
          updated_at: '2026-07-25T10:00:00.000Z',
          ts: '2026-07-25T10:00:00.000Z',
          ...item,
        };
      });
      filas.push(...items);
      return { data: this.modo ? items[0] : items, error: null };
    }

    if (this.op === 'update') {
      const tocadas = filas.filter((f) => this.filtros.every((p) => p(f)));
      tocadas.forEach((f) => Object.assign(f, this.payload as Fila));
      return { data: this.modo ? (tocadas[0] ?? null) : tocadas, error: null };
    }

    let encontradas = filas.filter((f) => this.filtros.every((p) => p(f)));
    if (this.contar) {
      return { data: this.soloCabecera ? null : encontradas, error: null, count: encontradas.length };
    }
    if (this.orden) {
      const { col, asc } = this.orden;
      encontradas = [...encontradas].sort((a, b) => {
        const av = String(a[col] ?? '');
        const bv = String(b[col] ?? '');
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.modo === 'single') {
      return encontradas[0]
        ? { data: encontradas[0], error: null }
        : { data: null, error: { message: 'no existe la fila' } };
    }
    if (this.modo === 'maybeSingle') return { data: encontradas[0] ?? null, error: null };
    return { data: encontradas, error: null };
  }
}

class SupabaseFalso {
  readonly store = new Map<string, Fila[]>();
  readonly errores = new Map<string, string>();
  private readonly seq = { n: 0 };

  from(tabla: string): QueryBuilderFalso {
    return new QueryBuilderFalso(tabla, this.store, this.errores, this.seq);
  }
  sembrar(tabla: string, filas: Fila[]): void {
    this.store.set(tabla, [...filas]);
  }
  forzarError(tabla: string, mensaje: string): void {
    this.errores.set(tabla, mensaje);
  }
  comoCliente(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

function filaDeLlamada(over: Fila = {}): Fila {
  return {
    id: 'call-1',
    conversation_id: 'conv-1',
    session_id: SESSION_ID,
    elevenlabs_conversation_id: null,
    proveedor_sip: null,
    numero_origen: TELEFONO,
    numero_destino: null,
    call_status: 'en_curso',
    iniciada_en: '2026-07-25T10:00:00.000Z',
    finalizada_en: null,
    voice_duration_s: null,
    transferida_a: null,
    consentimiento_grabacion: false,
    retencion_audio: false,
    disclosure_ejecutada: false,
    updated_at: '2026-07-25T10:01:00.000Z',
    ...over,
  };
}

describe('SupabaseCallRepository', () => {
  let fake: SupabaseFalso;

  beforeEach(() => {
    fake = new SupabaseFalso();
  });

  it('mapea snake_case a camelCase y timestamptz a Date, con null -> undefined', async () => {
    fake.sembrar('calls', [filaDeLlamada({ voice_duration_s: 42, transferida_a: NUMERO_EN_LISTA_BLANCA })]);
    const repo = new SupabaseCallRepository(fake.comoCliente());

    const call = await repo.findBySessionId(SESSION_ID);

    expect(call?.id).toBe('call-1');
    expect(call?.conversationId).toBe('conv-1');
    expect(call?.numeroOrigen).toBe(TELEFONO);
    expect(call?.numeroDestino).toBeUndefined();
    expect(call?.elevenlabsConversationId).toBeUndefined();
    expect(call?.finalizadaEn).toBeUndefined();
    expect(call?.voiceDurationS).toBe(42);
    expect(call?.transferidaA).toBe(NUMERO_EN_LISTA_BLANCA);
    expect(call?.iniciadaEn).toBeInstanceOf(Date);
    expect(call?.iniciadaEn.toISOString()).toBe('2026-07-25T10:00:00.000Z');
    expect(call?.updatedAt.toISOString()).toBe('2026-07-25T10:01:00.000Z');
    expect(call?.disclosureEjecutada).toBe(false);
  });

  it('devuelve null si la sesion no existe (nunca lanza por "no encontrado")', async () => {
    const repo = new SupabaseCallRepository(fake.comoCliente());
    await expect(repo.findBySessionId('sess-inexistente')).resolves.toBeNull();
    await expect(repo.findById('call-inexistente')).resolves.toBeNull();
  });

  it('create() no retiene audio ni da la revelacion por hecha', async () => {
    const repo = new SupabaseCallRepository(fake.comoCliente());

    const call = await repo.create({ conversationId: 'conv-1', sessionId: 'sess-nueva' });

    expect(call.callStatus).toBe('iniciada');
    expect(call.retencionAudio).toBe(false);
    expect(call.consentimientoGrabacion).toBe(false);
    expect(call.disclosureEjecutada).toBe(false);
    const fila = fake.store.get('calls')?.[0];
    expect(fila?.retencion_audio).toBe(false);
    expect(fila?.disclosure_ejecutada).toBe(false);
  });

  it('update() solo escribe las claves informadas; `null` si borra', async () => {
    fake.sembrar('calls', [filaDeLlamada()]);
    const repo = new SupabaseCallRepository(fake.comoCliente());

    await repo.update('call-1', { callStatus: 'transferida', transferidaA: NUMERO_EN_LISTA_BLANCA });

    const fila = fake.store.get('calls')?.[0];
    expect(fila?.call_status).toBe('transferida');
    expect(fila?.transferida_a).toBe(NUMERO_EN_LISTA_BLANCA);
    // No se toco lo que no se pidio tocar.
    expect(fila?.finalizada_en).toBeNull();
    expect(fila?.numero_origen).toBe(TELEFONO);

    await repo.update('call-1', { finalizadaEn: new Date('2026-07-25T10:10:00.000Z'), voiceDurationS: 120 });
    expect(fake.store.get('calls')?.[0]?.finalizada_en).toBe('2026-07-25T10:10:00.000Z');
    expect(fake.store.get('calls')?.[0]?.voice_duration_s).toBe(120);
  });

  it('marcarDisclosureEjecutada escribe el flag auditable', async () => {
    fake.sembrar('calls', [filaDeLlamada()]);
    const repo = new SupabaseCallRepository(fake.comoCliente());

    await repo.marcarDisclosureEjecutada('call-1');

    expect(fake.store.get('calls')?.[0]?.disclosure_ejecutada).toBe(true);
  });

  it('appendAudioEvent y appendLatencyMetric mapean en ambos sentidos', async () => {
    const repo = new SupabaseCallRepository(fake.comoCliente());

    const evento = await repo.appendAudioEvent({
      callId: 'call-1',
      tipo: 'barge_in',
      payload: { turno: 3 },
    });
    expect(evento.tipo).toBe('barge_in');
    expect(evento.ts).toBeInstanceOf(Date);
    expect(evento.payload).toEqual({ turno: 3 });
    expect(fake.store.get('audio_events')?.[0]?.call_id).toBe('call-1');

    const metrica = await repo.appendLatencyMetric({ callId: 'call-1', turno: 2, llmMs: 800, totalMs: 950 });
    expect(metrica).toEqual({ id: metrica.id, callId: 'call-1', turno: 2, llmMs: 800, totalMs: 950 });
    const fila = fake.store.get('latency_metrics')?.[0];
    expect(fila?.stt_ms).toBeNull();
    expect(fila?.tts_ms).toBeNull();
    expect(fila?.llm_ms).toBe(800);
  });

  it('siguienteTurno cuenta solo las metricas de ESA llamada', async () => {
    const repo = new SupabaseCallRepository(fake.comoCliente());
    await expect(repo.siguienteTurno('call-1')).resolves.toBe(1);

    fake.sembrar('latency_metrics', [
      { id: 'lm-1', call_id: 'call-1', turno: 1 },
      { id: 'lm-2', call_id: 'call-1', turno: 2 },
      { id: 'lm-3', call_id: 'call-otra', turno: 1 },
    ]);
    await expect(repo.siguienteTurno('call-1')).resolves.toBe(3);
    await expect(repo.siguienteTurno('call-otra')).resolves.toBe(2);
  });

  it('lanza con contexto ante un fallo de infraestructura, nunca lo traga', async () => {
    fake.forzarError('calls', 'conexion perdida');
    fake.forzarError('audio_events', 'permiso denegado');
    fake.forzarError('latency_metrics', 'timeout');
    const repo = new SupabaseCallRepository(fake.comoCliente());

    await expect(repo.findBySessionId('s')).rejects.toThrow(/calls\.findBySessionId/);
    await expect(repo.findById('c')).rejects.toThrow(/calls\.findById/);
    await expect(repo.create({ conversationId: 'c', sessionId: 's' })).rejects.toThrow(/calls\.create/);
    await expect(repo.update('c', { callStatus: 'fallida' })).rejects.toThrow(/calls\.update/);
    await expect(repo.marcarDisclosureEjecutada('c')).rejects.toThrow(/marcarDisclosureEjecutada/);
    await expect(repo.appendAudioEvent({ callId: 'c', tipo: 'fin' })).rejects.toThrow(/audio_events\.append/);
    await expect(repo.appendLatencyMetric({ callId: 'c', turno: 1 })).rejects.toThrow(/latency_metrics\.append/);
    await expect(repo.siguienteTurno('c')).rejects.toThrow(/siguienteTurno/);
  });
});

describe('SupabaseTranscriptRepository', () => {
  let fake: SupabaseFalso;

  beforeEach(() => {
    fake = new SupabaseFalso();
  });

  it('append y appendMany mapean camelCase -> snake_case', async () => {
    const repo = new SupabaseTranscriptRepository(fake.comoCliente());

    await repo.append({ callId: 'call-1', hablante: 'paciente', texto: 'Quiero una cita.' });
    await repo.appendMany([
      { callId: 'call-1', hablante: 'agente', texto: 'Con gusto.', tsInicioMs: 1200, tsFinMs: 2400, confianza: 0.97 },
    ]);

    const filas = fake.store.get('transcripts') ?? [];
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ call_id: 'call-1', hablante: 'paciente', ts_inicio_ms: null, confianza: null });
    expect(filas[1]).toMatchObject({ ts_inicio_ms: 1200, ts_fin_ms: 2400, confianza: 0.97 });
  });

  it('appendMany con lista vacia no toca la base', async () => {
    const repo = new SupabaseTranscriptRepository(fake.comoCliente());
    await expect(repo.appendMany([])).resolves.toEqual([]);
    expect(fake.store.get('transcripts')).toBeUndefined();
  });

  it('CRITICO: listByCall nunca devuelve lineas de otra llamada', async () => {
    fake.sembrar('transcripts', [
      { id: 't1', call_id: 'call-1', hablante: 'paciente', texto: 'mia', ts_inicio_ms: 100, ts_fin_ms: null, confianza: null },
      { id: 't2', call_id: 'call-2', hablante: 'paciente', texto: 'JAMAS debe aparecer', ts_inicio_ms: 50, ts_fin_ms: null, confianza: null },
    ]);
    const repo = new SupabaseTranscriptRepository(fake.comoCliente());

    const lineas = await repo.listByCall('call-1');

    expect(lineas).toHaveLength(1);
    expect(lineas[0]?.texto).toBe('mia');
  });

  it('convierte `confianza` numeric aunque llegue como string', async () => {
    fake.sembrar('transcripts', [
      { id: 't1', call_id: 'call-1', hablante: 'agente', texto: 'hola', ts_inicio_ms: null, ts_fin_ms: null, confianza: '0.85' },
    ]);
    const repo = new SupabaseTranscriptRepository(fake.comoCliente());

    const lineas = await repo.listByCall('call-1');

    expect(lineas[0]?.confianza).toBe(0.85);
  });

  it('lanza con contexto ante un fallo de infraestructura', async () => {
    fake.forzarError('transcripts', 'red caida');
    const repo = new SupabaseTranscriptRepository(fake.comoCliente());

    await expect(repo.append({ callId: 'c', hablante: 'agente', texto: 'x' })).rejects.toThrow(
      /transcripts\.append/,
    );
    await expect(repo.appendMany([{ callId: 'c', hablante: 'agente', texto: 'x' }])).rejects.toThrow(
      /transcripts\.appendMany/,
    );
    await expect(repo.listByCall('c')).rejects.toThrow(/transcripts\.listByCall/);
  });
});
