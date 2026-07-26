/**
 * CRITERIO DE ACEPTACION DE LA FASE 1.
 *
 * «Test de integracion que ejecuta un turno completo con channel:'whatsapp' y
 * otro con channel:'voice' USANDO EL MISMO SERVICIO, y verifica que solo
 * difiere el bloque de estilo del prompt. Los tests de guardrails de capa 2
 * bloquean un precio cerrado y una afirmacion clinica.»
 *
 * CORRECCION AL CRITERIO. Tal como esta redactado en la especificacion (§12,
 * Fase 1) es literalmente FALSO: el bloque 9 tambien difiere, porque `canal` es
 * una variable dinamica que se sustituye ahi. Lo que si es cierto, y es lo que
 * se verifica aqui, es la forma PRECISA:
 *
 *   · bloques 1-8  -> identicos BYTE A BYTE
 *   · bloque 9     -> identico salvo el token del canal
 *   · bloque 10    -> distinto (es el bloque de estilo)
 *
 * Si alguien mete logica de negocio ramificada por canal en cualquier otro
 * sitio del ensamblado, este test se cae.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  crearEntornoDePrueba,
  partirSystemEnBloques,
  type EntornoDePrueba,
} from '../helpers/dobles.js';
import { RESPUESTAS_CANONICAS, checkOutbound } from '../../src/core/claude/guardrails.js';
import { MENSAJE_DE_URGENCIA } from '../../src/core/conversation/conversation.service.js';
import type {
  InboundMessage,
  KnowledgeChunk,
  TurnChunk,
  TurnContext,
} from '../../src/core/types/index.js';

/** Instante fijo del turno. Sin esto el bloque 9 diferiria por la hora. */
const RECIBIDO_EN = new Date('2026-07-23T15:30:00Z'); // jueves, 10:30 en Lima

let env: EntornoDePrueba;

const fragmento = (clinicId: string): KnowledgeChunk => ({
  id: 'k1',
  clinicId,
  contenido: 'Horario de atencion: lunes a sabado de 8:00 a 20:00. Sede Miraflores.',
  fuente: 'faq',
  similarity: 0.91,
});

beforeEach(async () => {
  env = await crearEntornoDePrueba();
  env.rag.porDefecto = [fragmento(env.clinica.id)];
});

function entrante(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    clinicId: env.clinica.id,
    patientPhoneE164: '+51987654321',
    patientName: 'Rosa Quispe',
    text: 'Hola, quisiera saber si atienden los sabados.',
    channel: 'whatsapp',
    receivedAt: RECIBIDO_EN,
    ...over,
  };
}

/** TurnContext minimo, solo para invocar los guardrails fuera de un turno. */
function contextoMinimo(): TurnContext {
  return {
    conversationId: '33333333-3333-4333-8333-333333333333',
    clinic: env.clinica,
    patient: {
      id: '22222222-2222-4222-8222-222222222222',
      clinicId: env.clinica.id,
      telefonoE164: '+51987654321',
    },
    channel: 'voice',
    history: [],
    channelSwitched: false,
    comprehensionFailures: 0,
    now: RECIBIDO_EN,
  };
}

describe('un solo servicio para los dos canales', () => {
  it('bloques 1-8 identicos, bloque 9 identico salvo el canal, bloque 10 distinto', async () => {
    const respuesta = 'Claro que si. Atendemos de lunes a sabado en la sede de Miraflores.';
    env.claude.responder(respuesta).responder(respuesta);

    // MISMO servicio, MISMO instante, MISMO texto, MISMO nombre de paciente.
    // Solo se cambia el canal y el telefono (para que sean dos conversaciones
    // recien creadas y el bloque 9 no difiera tambien por las notas de sesion).
    const porTexto = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', patientPhoneE164: '+51987654321' }),
    );
    const porVoz = await env.servicio.handleTurn(
      entrante({ channel: 'voice', patientPhoneE164: '+51987654322' }),
    );

    expect(porTexto.channel).toBe('whatsapp');
    expect(porVoz.channel).toBe('voice');
    expect(porTexto.conversationId).not.toBe(porVoz.conversationId);

    expect(env.claude.llamadas).toHaveLength(2);
    const bloquesTexto = partirSystemEnBloques(env.claude.llamadas[0]!.system);
    const bloquesVoz = partirSystemEnBloques(env.claude.llamadas[1]!.system);

    expect(bloquesTexto).toHaveLength(10);
    expect(bloquesVoz).toHaveLength(10);

    // 1-8: identicos byte a byte. Incluye el bloque 8 (contexto RAG aprobado).
    expect(bloquesTexto.slice(0, 8)).toEqual(bloquesVoz.slice(0, 8));

    // 9: NO son iguales -- aqui es donde la redaccion del criterio falla.
    const [bloque9Texto, bloque9Voz] = [bloquesTexto[8]!, bloquesVoz[8]!];
    expect(bloque9Texto).not.toBe(bloque9Voz);
    // ...pero la UNICA diferencia es el token del canal.
    expect(bloque9Texto.replace('Canal: whatsapp', 'Canal: <CANAL>')).toBe(
      bloque9Voz.replace('Canal: voice', 'Canal: <CANAL>'),
    );

    // 10: el bloque de estilo. Distinto, y cada uno el suyo.
    expect(bloquesTexto[9]).not.toBe(bloquesVoz[9]);
    expect(bloquesTexto[9]).toContain('emojis moderados');
    expect(bloquesVoz[9]).toContain('todo se pronuncia');
  });

  it('el contexto RAG entra en el bloque 8 y es el mismo en los dos canales', async () => {
    env.claude.responder('Atendemos de lunes a sabado.').responder('Atendemos de lunes a sabado.');
    await env.servicio.handleTurn(entrante({ channel: 'whatsapp' }));
    await env.servicio.handleTurn(entrante({ channel: 'voice', patientPhoneE164: '+51987654322' }));

    for (const llamada of env.claude.llamadas) {
      const bloques = partirSystemEnBloques(llamada.system);
      expect(bloques[7]).toContain('lunes a sabado de 8:00 a 20:00');
    }
    expect(env.rag.consultas.map((c) => c.clinicId)).toEqual([env.clinica.id, env.clinica.id]);
  });
});

describe('capa 2 sobre el turno completo (no sobre una funcion suelta)', () => {
  it('bloquea un precio cerrado sin mencion de valoracion', async () => {
    env.claude.responder('Con gusto le explico. El implante cuesta S/ 2500.');

    const salida = await env.servicio.handleTurn(
      entrante({ text: 'Cuanto cuesta un implante?' }),
    );

    expect(salida.text).toBe(RESPUESTAS_CANONICAS.precio_cerrado_sin_valoracion);
    expect(salida.text).not.toContain('2500');
    // El incidente queda auditado, no solo logueado.
    expect(env.auditoria.con('guardrail_outbound_bloqueado')).not.toHaveLength(0);
  });

  it('deja pasar un RANGO de referencia que si menciona la valoracion', async () => {
    env.claude.responder(
      'El implante va desde S/ 2000 hasta S/ 3500 como referencia. El precio final depende de la valoracion del doctor.',
    );

    const salida = await env.servicio.handleTurn(entrante({ text: 'Cuanto cuesta un implante?' }));

    expect(salida.text).toContain('2000');
    expect(salida.text).toContain('valoracion');
    expect(env.auditoria.con('guardrail_outbound_bloqueado')).toHaveLength(0);
  });

  it('bloquea una afirmacion clinica', async () => {
    env.claude.responder('Usted tiene una infeccion en la muela.');

    const salida = await env.servicio.handleTurn(
      entrante({ text: 'Se me hinchó un poco la encía, qué será?' }),
    );

    expect(salida.text).toBe(RESPUESTAS_CANONICAS.afirmacion_clinica);
    expect(salida.text).not.toContain('infeccion');
  });

  it('nunca deja al paciente en silencio: el bloqueo siempre trae texto', async () => {
    env.claude.responder('Usted tiene caries.');
    const salida = await env.servicio.handleTurn(entrante());
    expect(salida.text.trim().length).toBeGreaterThan(0);
  });
});

describe('evidence explicita en checkOutbound', () => {
  const CITA = '2026-07-24T15:00:00.000Z'; // viernes 10:00 en Lima, dentro de horario

  it('bloquea «ya quedo agendada» cuando NO hubo tool_call de crear_cita', async () => {
    env.claude.responder('Listo, ya quedo agendada su cita.');

    const salida = await env.servicio.handleTurn(entrante({ text: 'Confirmo el viernes.' }));

    expect(salida.text).toBe(RESPUESTAS_CANONICAS.cita_afirmada_sin_tool_call);
    expect(env.calendar.eventos).toHaveLength(0);
  });

  it('deja pasar «ya quedo agendada» cuando crear_cita devolvio ok EN ESTE turno', async () => {
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-1',
            name: 'crear_cita',
            input: {
              inicio: CITA,
              duracionMin: 30,
              motivo: 'Valoracion',
              confirmadoPorPaciente: true,
            },
          },
        ],
        stopReason: 'tool_use',
      },
      { texto: 'Listo, ya quedo agendada su cita.' },
    );

    const salida = await env.servicio.handleTurn(entrante({ text: 'Confirmo el viernes.' }));

    // La evidencia NO puede venir del historial: la conversacion es nueva y el
    // resultado de la herramienta se escribio DESPUES de leerlo. Si el servicio
    // no pasara `evidence` explicita, la heuristica de respaldo fallaria cerrado
    // y esta respuesta legitima quedaria bloqueada.
    expect(salida.text).toBe('Listo, ya quedo agendada su cita.');
    expect(env.calendar.eventos).toHaveLength(1);
    expect(env.toolCalls.filas.filter((c) => c.herramienta === 'crear_cita')).toHaveLength(1);
    expect(env.toolCalls.filas[0]!.estado).toBe('ok');
  });

  it('bloquea la confirmacion si crear_cita fue rechazada', async () => {
    env.calendar.todoLibre = false; // colision: la herramienta devuelve rechazada_validacion
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-1',
            name: 'crear_cita',
            input: { inicio: CITA, duracionMin: 30, confirmadoPorPaciente: true },
          },
        ],
        stopReason: 'tool_use',
      },
      { texto: 'Listo, ya quedo agendada su cita.' },
    );

    const salida = await env.servicio.handleTurn(entrante({ text: 'Confirmo el viernes.' }));

    expect(salida.text).toBe(RESPUESTAS_CANONICAS.cita_afirmada_sin_tool_call);
    expect(env.calendar.eventos).toHaveLength(0);
  });
});

describe('capa 3: la urgencia aborta el flujo comercial', () => {
  it('no llega a llamar al modelo y escala con prioridad urgente', async () => {
    env.claude.responder('Con gusto le busco una cita para la proxima semana.');

    const salida = await env.servicio.handleTurn(
      entrante({ channel: 'voice', text: 'Ayuda, no puedo respirar y se me hincho toda la cara.' }),
    );

    // La respuesta comercial ni se genera: el pre-filtro lexico resuelve sin red.
    expect(env.claude.llamadas).toHaveLength(0);
    expect(salida.text).toBe(MENSAJE_DE_URGENCIA);
    expect(salida.escalate?.priority).toBe('urgente');
    expect(salida.escalate?.reason).toBe('urgencia');
    // En voz se propone el numero de la lista blanca; la herramienta lo valida.
    expect(salida.escalate?.transferNumber).toBe(env.clinica.transferWhitelist[0]);

    expect(env.notificaciones.escalamientos).toHaveLength(1);
    expect(env.conversaciones.filas[0]!.estado).toBe('escalada');
    expect(env.auditoria.con('urgencia_detectada')).toHaveLength(1);
  });

  it('el mensaje canonico de urgencia pasa la capa 2 (la excepcion nunca se ejerce)', () => {
    expect(checkOutbound(MENSAJE_DE_URGENCIA, contextoMinimo()).pass).toBe(true);
  });
});

describe('streamTurn emite progresivamente', () => {
  it('emite texto por frases y cierra con done', async () => {
    env.claude.responder(
      'Claro que si. Atendemos de lunes a sabado. Le puedo buscar un espacio esta semana.',
    );

    const chunks: TurnChunk[] = [];
    for await (const chunk of env.servicio.streamTurn(entrante({ channel: 'voice' }))) {
      chunks.push(chunk);
    }

    const textos = chunks.filter((c) => c.type === 'text');
    expect(textos.length).toBeGreaterThan(1); // no salio todo de golpe
    expect(chunks[chunks.length - 1]!.type).toBe('done');

    const reconstruido = textos.map((c) => c.delta).join('');
    const done = chunks[chunks.length - 1]!;
    if (done.type !== 'done') throw new Error('el ultimo chunk debe ser done');
    // Lo emitido y lo persistido son exactamente lo mismo.
    expect(done.message.text).toBe(reconstruido);
    expect(env.mensajes.de(done.message.conversationId, 'assistant')[0]!.contenido).toBe(
      reconstruido,
    );
  });

  it('no emite un solo caracter de una frase que la capa 2 va a bloquear', async () => {
    env.claude.responder('Le cuento. Usted tiene una infeccion. Le busco cita.');

    const emitidos: string[] = [];
    for await (const chunk of env.servicio.streamTurn(entrante())) {
      if (chunk.type === 'text') emitidos.push(chunk.delta);
    }

    const todo = emitidos.join('');
    expect(todo).not.toContain('infeccion');
    expect(todo).toContain(RESPUESTAS_CANONICAS.afirmacion_clinica);
  });
});

describe('persistencia del turno', () => {
  it('guarda el mensaje del paciente, el del asistente y la latencia', async () => {
    env.claude.responder('Atendemos de lunes a sabado.');
    const salida = await env.servicio.handleTurn(entrante());

    const usuarios = env.mensajes.de(salida.conversationId, 'user');
    const asistentes = env.mensajes.de(salida.conversationId, 'assistant');
    expect(usuarios).toHaveLength(1);
    expect(usuarios[0]!.contenido).toBe('Hola, quisiera saber si atienden los sabados.');
    expect(asistentes).toHaveLength(1);
    expect(asistentes[0]!.canal).toBe('whatsapp');
    expect(asistentes[0]!.latenciaMs).toBeGreaterThanOrEqual(0);
    expect(salida.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('persiste el resultado de la herramienta como mensaje de rol tool', async () => {
    env.claude.encolar(
      {
        toolUses: [
          {
            id: 'tu-1',
            name: 'consultar_agenda',
            input: {
              desde: '2026-07-24T13:00:00.000Z',
              hasta: '2026-07-25T00:00:00.000Z',
              duracionMin: 30,
            },
          },
        ],
        stopReason: 'tool_use',
      },
      { texto: 'Tengo espacio el viernes por la manana.' },
    );

    const salida = await env.servicio.handleTurn(entrante({ text: 'Que horarios tiene?' }));
    const herramientas = env.mensajes.de(salida.conversationId, 'tool');
    expect(herramientas).toHaveLength(1);
    expect(herramientas[0]!.contenido).toContain('consultar_agenda');
    expect(herramientas[0]!.contenido).toContain('"status":"ok"');
  });
});
