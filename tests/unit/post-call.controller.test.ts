/**
 * Tests de src/channels/voice/post-call.controller.ts.
 *
 * Lo que se comprueba, en el orden en que importa:
 *  1. FIRMA: header ausente, malformado, hash erroneo o timestamp viejo -> 401
 *     y NO se procesa NADA (ni transcripcion, ni audio, ni cierre de llamada).
 *  2. RECONCILIACION: lo que el gateway ya escribio turno a turno no se duplica,
 *     y un reintento del mismo webhook tampoco anade lineas.
 *  3. REVELACION (§7, criterio bloqueante): se marca `disclosure_ejecutada`
 *     solo si la primera intervencion del agente contiene LOS DOS elementos; si
 *     falta alguno, incumplimiento en nivel `error` y en `audit_log`.
 *  4. AUDIO: `full_audio` con retencion en cero se descarta SIN escribirlo.
 *  5. FALLO DE INICIO: busy / no-answer / unknown cierran la llamada como
 *     fallida y NO marcan la revelacion.
 *
 * No hay cuenta de ElevenLabs: todo son dobles en memoria y nada toca la red.
 * La firma se calcula con el MISMO `createHmac` que usa el verificador, sobre
 * la composicion que documenta `src/infra/elevenlabs.client.ts` (asuncion
 * declarada alli: `${timestamp}.${rawBody}`).
 */
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  RUTA_WEBHOOK_POST_LLAMADA,
  aHablante,
  clasificarPayload,
  handlePostCallWebhookEvent,
  lineasDelPayload,
  mapearEstadoFinal,
  normalizarMotivoDeFallo,
  planificarReconciliacion,
  postCallWebhookPayloadSchema,
  postCallWebhookPlugin,
  sessionIdDelPayload,
  verificarGuionDeRevelacion,
  type PostCallDeps,
} from '../../src/channels/voice/post-call.controller.js';
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
  TranscriptLine,
  TranscriptRepository,
} from '../../src/channels/voice/voice.types.js';
import { AuditRepositoryDoble, LoggerDoble } from '../helpers/dobles.js';

const SECRETO = 'secreto-del-webhook-post-llamada';
const SESSION_ID = 'sess-voz-001';
const CONVERSACION_ELEVENLABS = 'conv_elevenlabs_abc123';
const AHORA = new Date('2026-07-26T12:00:00Z');

/** Guion literal de la §7 de la especificacion. Cumple los DOS elementos. */
const GUION_DE_REVELACION =
  'Hola, le atiende el asistente virtual de Clinica Dental Sonrisa. Soy un asistente de ' +
  'inteligencia artificial, no una persona. Esta llamada puede ser grabada y compartida con ' +
  'nuestros proveedores de servicio para fines de calidad y mejora del servicio. Si en cualquier ' +
  'momento prefiere hablar con una persona, digamelo y le transfiero. En que le puedo ayudar?';

// ---------------------------------------------------------------------------
// Dobles de persistencia
// ---------------------------------------------------------------------------

let secuencia = 0;
const nuevoId = (prefijo: string): string => {
  secuencia += 1;
  return `${prefijo}-${secuencia}`;
};

class CallRepositoryDoble implements CallRepository {
  readonly llamadas: CallRecord[] = [];
  readonly eventos: AudioEvent[] = [];
  readonly actualizaciones: Array<{ callId: string; cambios: ActualizacionDeLlamada }> = [];
  readonly disclosuresMarcadas: string[] = [];

  sembrar(over: Partial<CallRecord> = {}): CallRecord {
    const call: CallRecord = {
      id: nuevoId('call'),
      conversationId: nuevoId('conv'),
      sessionId: SESSION_ID,
      callStatus: 'en_curso',
      iniciadaEn: new Date('2026-07-26T11:50:00Z'),
      consentimientoGrabacion: false,
      retencionAudio: false,
      disclosureEjecutada: false,
      updatedAt: new Date('2026-07-26T11:50:00Z'),
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
    return this.sembrar({ conversationId: nueva.conversationId, sessionId: nueva.sessionId });
  }

  async update(callId: string, cambios: ActualizacionDeLlamada): Promise<CallRecord> {
    this.actualizaciones.push({ callId, cambios });
    const call = this.llamadas.find((c) => c.id === callId);
    if (!call) throw new Error(`llamada inexistente: ${callId}`);
    if (cambios.callStatus !== undefined) call.callStatus = cambios.callStatus;
    if (cambios.finalizadaEn !== undefined && cambios.finalizadaEn !== null) {
      call.finalizadaEn = cambios.finalizadaEn;
    }
    if (cambios.voiceDurationS !== undefined && cambios.voiceDurationS !== null) {
      call.voiceDurationS = cambios.voiceDurationS;
    }
    if (cambios.elevenlabsConversationId !== undefined && cambios.elevenlabsConversationId !== null) {
      call.elevenlabsConversationId = cambios.elevenlabsConversationId;
    }
    return call;
  }

  async marcarDisclosureEjecutada(callId: string): Promise<void> {
    this.disclosuresMarcadas.push(callId);
    const call = this.llamadas.find((c) => c.id === callId);
    if (call) call.disclosureEjecutada = true;
  }

  async appendAudioEvent(evento: NuevoAudioEvent): Promise<AudioEvent> {
    const fila: AudioEvent = {
      id: nuevoId('evt'),
      callId: evento.callId,
      tipo: evento.tipo,
      ts: evento.ts ?? AHORA,
      ...(evento.payload ? { payload: evento.payload } : {}),
    };
    this.eventos.push(fila);
    return fila;
  }

  async appendLatencyMetric(metrica: NuevaLatencyMetric): Promise<LatencyMetric> {
    return { id: nuevoId('lat'), callId: metrica.callId, turno: metrica.turno };
  }

  async siguienteTurno(): Promise<number> {
    return 1;
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
    const filas = lineas.map((l) => ({ id: nuevoId('tr'), ...l }));
    this.lineas.push(...filas);
    return filas;
  }

  async listByCall(callId: string): Promise<TranscriptLine[]> {
    return this.lineas.filter((l) => l.callId === callId);
  }
}

interface Entorno {
  deps: PostCallDeps;
  calls: CallRepositoryDoble;
  transcripts: TranscriptRepositoryDoble;
  audit: AuditRepositoryDoble;
  logger: LoggerDoble;
}

function crearEntorno(over: Partial<PostCallDeps> = {}): Entorno {
  const calls = new CallRepositoryDoble();
  const transcripts = new TranscriptRepositoryDoble();
  const audit = new AuditRepositoryDoble();
  const logger = new LoggerDoble();

  const deps: PostCallDeps = {
    calls,
    transcripts,
    audit,
    logger,
    webhookSecret: SECRETO,
    retencionAudioDias: 0,
    now: () => AHORA,
    ...over,
  };

  return { deps, calls, transcripts, audit, logger };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

interface Turno {
  role: string;
  message: string;
  time_in_call_secs?: number;
}

function payloadDeTranscripcion(
  turnos: Turno[],
  over: { status?: string; sessionId?: string; duracion?: number } = {},
): Record<string, unknown> {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(AHORA.getTime() / 1000),
    data: {
      agent_id: 'agent_demo',
      conversation_id: CONVERSACION_ELEVENLABS,
      status: over.status ?? 'done',
      transcript: turnos,
      has_audio: false,
      metadata: { call_duration_secs: over.duracion ?? 96 },
      conversation_initiation_client_data: {
        dynamic_variables: { session_id: over.sessionId ?? SESSION_ID },
      },
    },
  };
}

function payloadDeAudio(base64: string): Record<string, unknown> {
  return {
    type: 'post_call_audio',
    event_timestamp: Math.floor(AHORA.getTime() / 1000),
    data: {
      agent_id: 'agent_demo',
      conversation_id: CONVERSACION_ELEVENLABS,
      full_audio: base64,
      conversation_initiation_client_data: { dynamic_variables: { session_id: SESSION_ID } },
    },
  };
}

function payloadDeFallo(failureReason: string): Record<string, unknown> {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(AHORA.getTime() / 1000),
    data: {
      agent_id: 'agent_demo',
      conversation_id: CONVERSACION_ELEVENLABS,
      failure_reason: failureReason,
      conversation_initiation_client_data: { dynamic_variables: { session_id: SESSION_ID } },
    },
  };
}

/** Misma composicion que documenta `elevenlabs.client.ts`: `${timestamp}.${rawBody}`. */
function firmar(rawBody: string, opciones: { secreto?: string; timestamp?: number } = {}): string {
  const t = opciones.timestamp ?? Math.floor(AHORA.getTime() / 1000);
  const hash = createHmac('sha256', opciones.secreto ?? SECRETO)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return `t=${t},v0=${hash}`;
}

// ---------------------------------------------------------------------------
// 1. Firma
// ---------------------------------------------------------------------------

describe('postCallWebhookPlugin - verificacion de firma', () => {
  async function pedir(
    entorno: Entorno,
    cuerpo: Record<string, unknown>,
    firma: string | undefined,
  ): Promise<number> {
    const app = Fastify();
    await app.register(postCallWebhookPlugin, entorno.deps);
    await app.ready();

    const rawBody = JSON.stringify(cuerpo);
    const respuesta = await app.inject({
      method: 'POST',
      url: RUTA_WEBHOOK_POST_LLAMADA,
      headers: {
        'content-type': 'application/json',
        ...(firma !== undefined ? { 'elevenlabs-signature': firma } : {}),
      },
      payload: rawBody,
    });

    await app.close();
    return respuesta.statusCode;
  }

  it('acepta con 200 una firma valida', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    expect(await pedir(entorno, cuerpo, firmar(JSON.stringify(cuerpo)))).toBe(200);
  });

  it('rechaza con 401 si falta el header ElevenLabs-Signature, sin tocar nada', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);

    expect(await pedir(entorno, cuerpo, undefined)).toBe(401);

    expect(entorno.transcripts.lineas).toHaveLength(0);
    expect(entorno.calls.actualizaciones).toHaveLength(0);
    expect(entorno.calls.disclosuresMarcadas).toHaveLength(0);
    expect(call.callStatus).toBe('en_curso');
  });

  it('rechaza con 401 un header con formato invalido', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    expect(await pedir(entorno, cuerpo, 'firma-sin-formato')).toBe(401);
  });

  it('rechaza con 401 una firma calculada con otro secreto', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    const firma = firmar(JSON.stringify(cuerpo), { secreto: 'otro-secreto' });
    expect(await pedir(entorno, cuerpo, firma)).toBe(401);
  });

  it('rechaza con 401 si el cuerpo se altero despues de firmarlo', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const original = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    const firma = firmar(JSON.stringify(original));
    const alterado = payloadDeTranscripcion([{ role: 'agent', message: 'Hola.' }]);
    expect(await pedir(entorno, alterado, firma)).toBe(401);
  });

  it('rechaza con 401 un timestamp fuera de la ventana de tolerancia (replay)', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    // Una hora antes: firma criptograficamente correcta, pero vieja.
    const viejo = Math.floor(AHORA.getTime() / 1000) - 3600;
    const firma = firmar(JSON.stringify(cuerpo), { timestamp: viejo });
    expect(await pedir(entorno, cuerpo, firma)).toBe(401);
  });

  it('rechaza con 401 cuando el despliegue no tiene secreto configurado (falla cerrado)', async () => {
    const entorno = crearEntorno({ webhookSecret: '' });
    entorno.calls.sembrar();
    const cuerpo = payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]);
    expect(await pedir(entorno, cuerpo, firmar(JSON.stringify(cuerpo), { secreto: '' }))).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Clasificacion de los tres payloads documentados
// ---------------------------------------------------------------------------

describe('clasificarPayload - los tres tipos de la §7', () => {
  const clasificar = (crudo: Record<string, unknown>) =>
    clasificarPayload(postCallWebhookPayloadSchema.parse(crudo));

  it('reconoce el payload de transcripcion', () => {
    expect(clasificar(payloadDeTranscripcion([{ role: 'agent', message: 'Hola' }]))).toBe('transcripcion');
  });

  it('reconoce el payload de audio', () => {
    expect(clasificar(payloadDeAudio('QUJD'))).toBe('audio');
  });

  it('reconoce el fallo de inicio aunque `type` diga transcripcion', () => {
    // Se discrimina por FORMA: `failure_reason` manda sobre el literal de `type`.
    expect(clasificar(payloadDeFallo('busy'))).toBe('fallo_de_inicio');
  });

  it('un payload sin forma reconocible no se inventa un tipo', () => {
    expect(clasificar({ type: 'algo_nuevo', data: {} })).toBe('desconocido');
  });

  it('normaliza los tres motivos de fallo documentados y cae en unknown si no encaja', () => {
    expect(normalizarMotivoDeFallo('busy')).toBe('busy');
    expect(normalizarMotivoDeFallo('no-answer')).toBe('no-answer');
    expect(normalizarMotivoDeFallo('no_answer')).toBe('no-answer');
    expect(normalizarMotivoDeFallo('unknown')).toBe('unknown');
    expect(normalizarMotivoDeFallo('algo-que-no-existe')).toBe('unknown');
    expect(normalizarMotivoDeFallo(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 3. Revelacion obligatoria (§7) — criterio bloqueante
// ---------------------------------------------------------------------------

describe('verificarGuionDeRevelacion - exige LOS DOS elementos', () => {
  it('acepta el guion literal de la especificacion', () => {
    const r = verificarGuionDeRevelacion(GUION_DE_REVELACION);
    expect(r).toEqual({ mencionaIa: true, mencionaGrabacion: true, cumple: true });
  });

  it('no depende de las tildes ni de las mayusculas', () => {
    const r = verificarGuionDeRevelacion(
      'SOY UN ASISTENTE DE INTELIGENCIA ARTIFICIAL. Esta llamada será grabación registrada.',
    );
    expect(r.cumple).toBe(true);
  });

  it('rechaza si solo avisa de que es IA (falta la grabacion)', () => {
    const r = verificarGuionDeRevelacion(
      'Hola, soy un asistente de inteligencia artificial. En que le puedo ayudar?',
    );
    expect(r).toEqual({ mencionaIa: true, mencionaGrabacion: false, cumple: false });
  });

  it('rechaza si solo avisa de la grabacion (falta que es IA)', () => {
    const r = verificarGuionDeRevelacion('Buenos dias, esta llamada puede ser grabada. Digame.');
    expect(r).toEqual({ mencionaIa: false, mencionaGrabacion: true, cumple: false });
  });

  it('un saludo amable que no revela nada NO cumple', () => {
    const r = verificarGuionDeRevelacion('Hola, le atiende Ana de la clinica. En que le ayudo?');
    expect(r.cumple).toBe(false);
  });
});

describe('handlePostCallWebhookEvent - marca disclosure_ejecutada solo con evidencia', () => {
  it('marca la revelacion cuando la transcripcion real contiene el guion', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    const resultado = await handlePostCallWebhookEvent(
      payloadDeTranscripcion([
        { role: 'agent', message: GUION_DE_REVELACION, time_in_call_secs: 0 },
        { role: 'user', message: 'Quisiera una cita', time_in_call_secs: 9 },
      ]),
      entorno.deps,
    );

    expect(resultado.tipo).toBe('transcripcion');
    expect(resultado.disclosureCumple).toBe(true);
    expect(entorno.calls.disclosuresMarcadas).toEqual([call.id]);
    expect(call.disclosureEjecutada).toBe(true);
    expect(entorno.audit.con('disclosure_verificada')).toHaveLength(1);
    expect(entorno.audit.con('disclosure_incumplida')).toHaveLength(0);
  });

  it('registra el incumplimiento en nivel error y en audit_log si falta un elemento', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    const resultado = await handlePostCallWebhookEvent(
      payloadDeTranscripcion([
        { role: 'agent', message: 'Hola, soy el asistente de inteligencia artificial de la clinica.' },
        { role: 'user', message: 'Hola' },
      ]),
      entorno.deps,
    );

    expect(resultado.disclosureCumple).toBe(false);
    expect(entorno.calls.disclosuresMarcadas).toHaveLength(0);
    expect(call.disclosureEjecutada).toBe(false);

    const incumplimientos = entorno.audit.con('disclosure_incumplida');
    expect(incumplimientos).toHaveLength(1);
    expect(incumplimientos[0]?.detalle).toMatchObject({
      menciona_ia: true,
      menciona_grabacion: false,
      criterio: 'bloqueante',
    });

    const errores = entorno.logger.de('error');
    expect(errores.some((l) => l.msg?.includes('INCUMPLIMIENTO'))).toBe(true);
  });

  it('no marca la revelacion si el agente nunca intervino', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();

    const resultado = await handlePostCallWebhookEvent(
      payloadDeTranscripcion([{ role: 'user', message: 'Hola? Hola?' }]),
      entorno.deps,
    );

    expect(resultado.disclosureCumple).toBe(false);
    expect(entorno.calls.disclosuresMarcadas).toHaveLength(0);
    expect(entorno.audit.con('disclosure_incumplida')[0]?.detalle).toMatchObject({
      hubo_intervencion_del_agente: false,
    });
  });

  it('NO registra el texto de la transcripcion en el log (regla 8: nada de PII)', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();

    await handlePostCallWebhookEvent(
      payloadDeTranscripcion([
        { role: 'agent', message: 'Buenas, dime.' },
        { role: 'user', message: 'Mi DNI es 45678912 y me duele mucho la muela' },
      ]),
      entorno.deps,
    );

    const todo = JSON.stringify(entorno.logger.lineas);
    expect(todo).not.toContain('45678912');
    expect(todo).not.toContain('me duele mucho la muela');
  });
});

// ---------------------------------------------------------------------------
// 4. Reconciliacion de transcripcion
// ---------------------------------------------------------------------------

describe('planificarReconciliacion - no duplica lo que ya escribio el gateway', () => {
  it('descarta las lineas que ya estan y anade solo las nuevas', () => {
    const plan = planificarReconciliacion(
      [
        { hablante: 'agente', texto: 'Buenas tardes, le atiendo enseguida.' },
        { hablante: 'paciente', texto: 'Quisiera una cita para el jueves' },
        { hablante: 'agente', texto: 'Tengo hueco a las cuatro y media.' },
      ],
      [
        { hablante: 'agente', texto: 'Buenas tardes, le atiendo enseguida.' },
        { hablante: 'paciente', texto: 'Quisiera una cita para el jueves' },
      ],
    );

    expect(plan.yaPresentes).toBe(2);
    expect(plan.aAnadir).toHaveLength(1);
    expect(plan.aAnadir[0]?.texto).toBe('Tengo hueco a las cuatro y media.');
  });

  it('reconoce la misma frase con distinta puntuacion y tildes', () => {
    const plan = planificarReconciliacion(
      [{ hablante: 'paciente', texto: '¿Cuánto cuesta una limpieza dental?' }],
      [{ hablante: 'paciente', texto: 'cuanto cuesta una limpieza dental' }],
    );
    expect(plan.aAnadir).toHaveLength(0);
    expect(plan.yaPresentes).toBe(1);
  });

  it('reconoce la linea del agente aunque el gateway le anteponga la expresion puente', () => {
    const plan = planificarReconciliacion(
      [{ hablante: 'agente', texto: 'Tengo hueco el jueves a las cuatro y media.' }],
      [{ hablante: 'agente', texto: 'Un momento, por favor... Tengo hueco el jueves a las cuatro y media.' }],
    );
    expect(plan.aAnadir).toHaveLength(0);
  });

  it('no confunde a los hablantes: el mismo texto de otro hablante es una linea distinta', () => {
    const plan = planificarReconciliacion(
      [{ hablante: 'agente', texto: 'Confirmamos el jueves a las cuatro' }],
      [{ hablante: 'paciente', texto: 'Confirmamos el jueves a las cuatro' }],
    );
    expect(plan.aAnadir).toHaveLength(1);
  });

  it('una frase corta repetida de verdad se conserva dos veces (emparejamiento por multiconjunto)', () => {
    const plan = planificarReconciliacion(
      [
        { hablante: 'paciente', texto: 'Si' },
        { hablante: 'paciente', texto: 'Si' },
      ],
      [{ hablante: 'paciente', texto: 'Si' }],
    );
    expect(plan.yaPresentes).toBe(1);
    expect(plan.aAnadir).toHaveLength(1);
  });

  it('no aplica contencion a frases cortas: «si» no absorbe cualquier linea larga', () => {
    const plan = planificarReconciliacion(
      [{ hablante: 'paciente', texto: 'Si' }],
      [{ hablante: 'paciente', texto: 'Si, quisiera una cita para revision general' }],
    );
    expect(plan.aAnadir).toHaveLength(1);
  });
});

describe('handlePostCallWebhookEvent - reconciliacion contra la base', () => {
  it('solo persiste las lineas que faltaban', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    // Lo que el gateway ya escribio turno a turno (sin ts_inicio_ms).
    await entorno.transcripts.appendMany([
      { callId: call.id, hablante: 'agente', texto: GUION_DE_REVELACION },
      { callId: call.id, hablante: 'paciente', texto: 'Quisiera una cita para el jueves' },
    ]);

    const resultado = await handlePostCallWebhookEvent(
      payloadDeTranscripcion([
        { role: 'agent', message: GUION_DE_REVELACION, time_in_call_secs: 0 },
        { role: 'user', message: 'Quisiera una cita para el jueves', time_in_call_secs: 12 },
        { role: 'agent', message: 'Perfecto, tengo hueco a las cuatro y media.', time_in_call_secs: 15 },
      ]),
      entorno.deps,
    );

    expect(resultado.reconciliacion).toMatchObject({ anadidas: 1, yaPresentes: 2 });
    expect(entorno.transcripts.lineas).toHaveLength(3);
    // La linea nueva llega con offset de audio: es la unica con orden fiable
    // (ver el VACIO DEL ESQUEMA de transcript.repository.ts).
    expect(entorno.transcripts.lineas[2]?.tsInicioMs).toBe(15000);
  });

  it('un reintento del MISMO webhook no anade ni una linea', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const payload = payloadDeTranscripcion([
      { role: 'agent', message: GUION_DE_REVELACION, time_in_call_secs: 0 },
      { role: 'user', message: 'Quisiera una cita para el jueves', time_in_call_secs: 12 },
    ]);

    const primera = await handlePostCallWebhookEvent(payload, entorno.deps);
    const segunda = await handlePostCallWebhookEvent(payload, entorno.deps);

    expect(primera.reconciliacion?.anadidas).toBe(2);
    expect(segunda.reconciliacion?.anadidas).toBe(0);
    expect(segunda.reconciliacion?.yaPresentes).toBe(2);
    expect(entorno.transcripts.lineas).toHaveLength(2);
  });

  it('descarta las entradas con rol desconocido o mensaje vacio sin fallar', () => {
    const payload = postCallWebhookPayloadSchema.parse(
      payloadDeTranscripcion([
        { role: 'agent', message: 'Hola' },
        { role: 'system', message: 'tool result' },
        { role: 'user', message: '   ' },
      ]),
    );
    const lineas = lineasDelPayload(payload);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]?.hablante).toBe('agente');
  });

  it('mapea los alias de rol del proveedor', () => {
    expect(aHablante('agent')).toBe('agente');
    expect(aHablante('assistant')).toBe('agente');
    expect(aHablante('user')).toBe('paciente');
    expect(aHablante('customer')).toBe('paciente');
    expect(aHablante('tool')).toBeUndefined();
    expect(aHablante(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Audio — control C8
// ---------------------------------------------------------------------------

describe('handlePostCallWebhookEvent - audio', () => {
  it('descarta full_audio SIN escribirlo cuando la retencion es cero', async () => {
    const entorno = crearEntorno({ retencionAudioDias: 0 });
    const call = entorno.calls.sembrar();

    const resultado = await handlePostCallWebhookEvent(
      payloadDeAudio(Buffer.from('audio-mp3-simulado').toString('base64')),
      entorno.deps,
    );

    expect(resultado).toMatchObject({ tipo: 'audio', audioDescartado: true, callId: call.id });
    // Ni transcripcion, ni evento, ni columna: el audio no aterriza en ningun sitio.
    expect(entorno.transcripts.lineas).toHaveLength(0);
    expect(entorno.calls.eventos).toHaveLength(0);

    const registro = entorno.audit.con('audio_post_llamada_descartado');
    expect(registro).toHaveLength(1);
    expect(registro[0]?.detalle).toMatchObject({
      motivo: 'politica_de_retencion_cero',
      retencion_audio_dias: 0,
    });
  });

  it('nunca deja el base64 del audio en el log ni en la auditoria', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();
    const base64 = Buffer.from('contenido-de-voz-del-paciente').toString('base64');

    await handlePostCallWebhookEvent(payloadDeAudio(base64), entorno.deps);

    expect(JSON.stringify(entorno.logger.lineas)).not.toContain(base64);
    expect(JSON.stringify(entorno.audit.filas)).not.toContain(base64);
  });

  it('lo descarta igual cuando la politica lo permitiria, y lo dice en nivel error', async () => {
    // No hay almacen de audio en el esquema: fingir que se guardo seria peor.
    const entorno = crearEntorno({ retencionAudioDias: 30 });
    entorno.calls.sembrar({ retencionAudio: true });

    const resultado = await handlePostCallWebhookEvent(payloadDeAudio('QUJDRA=='), entorno.deps);

    expect(resultado.audioDescartado).toBe(true);
    expect(entorno.audit.con('audio_post_llamada_descartado')[0]?.detalle).toMatchObject({
      motivo: 'sin_almacen_de_audio',
    });
    expect(entorno.logger.de('error')).not.toHaveLength(0);
  });

  it('descarta el audio aunque no exista la fila de `calls`', async () => {
    const entorno = crearEntorno();
    const resultado = await handlePostCallWebhookEvent(payloadDeAudio('QUJD'), entorno.deps);
    expect(resultado).toMatchObject({ tipo: 'audio', audioDescartado: true, motivo: 'llamada_no_encontrada' });
  });
});

// ---------------------------------------------------------------------------
// 6. Cierre de la llamada y fallo de inicio
// ---------------------------------------------------------------------------

describe('handlePostCallWebhookEvent - cierre de la llamada', () => {
  it('consolida estado, finalizada_en y voice_duration_s', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    await handlePostCallWebhookEvent(
      payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }], { duracion: 137 }),
      entorno.deps,
    );

    expect(call.callStatus).toBe('finalizada');
    expect(call.voiceDurationS).toBe(137);
    expect(call.finalizadaEn?.toISOString()).toBe(AHORA.toISOString());
    expect(entorno.calls.eventos.filter((e) => e.tipo === 'fin')).toHaveLength(1);
  });

  it('enlaza elevenlabs_conversation_id con la fila encontrada por session_id', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    await handlePostCallWebhookEvent(
      payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]),
      entorno.deps,
    );

    expect(call.elevenlabsConversationId).toBe(CONVERSACION_ELEVENLABS);
  });

  it('NO pisa el estado `transferida`: es el rastro del escalamiento', async () => {
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar({ callStatus: 'transferida', transferidaA: '+51987000111' });

    await handlePostCallWebhookEvent(
      payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]),
      entorno.deps,
    );

    expect(call.callStatus).toBe('transferida');
    expect(call.voiceDurationS).toBe(96);
  });

  it('mapea el estado del proveedor', () => {
    expect(mapearEstadoFinal('done', 'en_curso')).toBe('finalizada');
    expect(mapearEstadoFinal('failed', 'en_curso')).toBe('fallida');
    expect(mapearEstadoFinal(undefined, 'en_curso')).toBe('finalizada');
    expect(mapearEstadoFinal('failed', 'transferida')).toBe('transferida');
  });

  it('sin fila en `calls` no consolida nada y lo dice', async () => {
    const entorno = crearEntorno();
    const resultado = await handlePostCallWebhookEvent(
      payloadDeTranscripcion([{ role: 'agent', message: GUION_DE_REVELACION }]),
      entorno.deps,
    );
    expect(resultado).toMatchObject({ tipo: 'transcripcion', motivo: 'llamada_no_encontrada' });
    expect(entorno.transcripts.lineas).toHaveLength(0);
  });
});

describe('handlePostCallWebhookEvent - fallo de inicio de llamada', () => {
  for (const motivo of ['busy', 'no-answer', 'unknown'] as const) {
    it(`marca la llamada como fallida con failure_reason=${motivo}`, async () => {
      const entorno = crearEntorno();
      const call = entorno.calls.sembrar();

      const resultado = await handlePostCallWebhookEvent(payloadDeFallo(motivo), entorno.deps);

      expect(resultado).toMatchObject({ tipo: 'fallo_de_inicio', callId: call.id });
      expect(call.callStatus).toBe('fallida');
      expect(call.voiceDurationS).toBe(0);
      expect(entorno.audit.con('llamada_no_iniciada')[0]?.detalle).toMatchObject({
        failure_reason: motivo,
      });
    });
  }

  it('una llamada que no llego a establecerse NUNCA marca disclosure_ejecutada', async () => {
    // Marcarla inflaria el porcentaje de cumplimiento con llamadas que no ocurrieron.
    const entorno = crearEntorno();
    const call = entorno.calls.sembrar();

    await handlePostCallWebhookEvent(payloadDeFallo('no-answer'), entorno.deps);

    expect(entorno.calls.disclosuresMarcadas).toHaveLength(0);
    expect(call.disclosureEjecutada).toBe(false);
  });

  it('registra el motivo crudo cuando el proveedor manda uno no documentado', async () => {
    const entorno = crearEntorno();
    entorno.calls.sembrar();

    await handlePostCallWebhookEvent(payloadDeFallo('carrier_rejected'), entorno.deps);

    expect(entorno.audit.con('llamada_no_iniciada')[0]?.detalle).toMatchObject({
      failure_reason: 'unknown',
      failure_reason_crudo: 'carrier_rejected',
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Robustez del payload
// ---------------------------------------------------------------------------

describe('handlePostCallWebhookEvent - payloads degradados', () => {
  it('un payload sin `data` se ignora sin lanzar', async () => {
    const entorno = crearEntorno();
    await expect(handlePostCallWebhookEvent({ type: 'post_call_transcription' }, entorno.deps)).resolves
      .toMatchObject({ tipo: 'desconocido', motivo: 'payload_invalido' });
  });

  it('un payload de otra plataforma se ignora sin lanzar', async () => {
    const entorno = crearEntorno();
    await expect(handlePostCallWebhookEvent({ esto: 'no es de elevenlabs' }, entorno.deps)).resolves
      .toMatchObject({ tipo: 'desconocido' });
  });

  it('encuentra el session_id en las distintas ubicaciones posibles', () => {
    const enMetadata = postCallWebhookPayloadSchema.parse({
      data: { conversation_id: 'x', metadata: { session_id: 'sess-en-metadata' } },
    });
    expect(sessionIdDelPayload(enMetadata)).toBe('sess-en-metadata');

    const sinNinguna = postCallWebhookPayloadSchema.parse({ data: { conversation_id: 'x' } });
    expect(sessionIdDelPayload(sinNinguna)).toBeUndefined();
  });

  it('usa el conversation_id de ElevenLabs como ultimo recurso para localizar la llamada', async () => {
    const entorno = crearEntorno();
    // Despliegue donde el session_id inyectado ES el id de conversacion.
    const call = entorno.calls.sembrar({ sessionId: CONVERSACION_ELEVENLABS });

    const payload = {
      type: 'post_call_transcription',
      data: {
        conversation_id: CONVERSACION_ELEVENLABS,
        status: 'done',
        transcript: [{ role: 'agent', message: GUION_DE_REVELACION }],
      },
    };

    const resultado = await handlePostCallWebhookEvent(payload, entorno.deps);
    expect(resultado.callId).toBe(call.id);
  });
});
