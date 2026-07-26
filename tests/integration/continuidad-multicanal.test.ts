/**
 * TEST DE ACEPTACION DE §10 — continuidad multicanal.
 *
 * «Iniciar por voz -> colgar -> escribir por WhatsApp -> el agente retoma con el
 * contexto y EL MISMO conversation_id.»
 *
 * Se comprueba tambien lo que la especificacion deja implicito y sin lo cual la
 * continuidad se rompe en silencio:
 *   · el telefono se normaliza a E.164, asi que dos canales que lo escriben
 *     distinto siguen siendo el mismo paciente;
 *   · fuera de la ventana de 72 h se crea una conversacion NUEVA;
 *   · el salto de canal se anuncia al paciente (nota en el bloque 9 del prompt).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  crearEntornoDePrueba,
  partirSystemEnBloques,
  type EntornoDePrueba,
} from '../helpers/dobles.js';
import type { InboundMessage } from '../../src/core/types/index.js';

const HORA_MS = 60 * 60 * 1000;
/** Jueves 10:30 en Lima. La llamada empieza aqui. */
const T0 = new Date('2026-07-23T15:30:00Z');

let env: EntornoDePrueba;

beforeEach(async () => {
  env = await crearEntornoDePrueba();
});

/** Mueve el reloj de la persistencia y devuelve el instante. */
function enElInstante(ms: number): Date {
  const fecha = new Date(T0.getTime() + ms);
  env.conversaciones.reloj = () => fecha;
  env.mensajes.reloj = () => fecha;
  return fecha;
}

function entrante(over: Partial<InboundMessage> & Pick<InboundMessage, 'channel'>): InboundMessage {
  return {
    clinicId: env.clinica.id,
    patientPhoneE164: '+51987654321',
    patientName: 'Rosa Quispe',
    text: 'Hola',
    receivedAt: T0,
    ...over,
  };
}

describe('la conversacion es del paciente, no del canal', () => {
  it('empieza por voz, se corta, sigue por WhatsApp y conserva el mismo conversation_id', async () => {
    env.claude
      .responder('Con gusto. Tenemos espacio el viernes por la manana.')
      .responder('Retomamos lo del viernes por la manana entonces.');

    // --- Turno 1: por voz ---
    const t0 = enElInstante(0);
    const porVoz = await env.servicio.handleTurn(
      entrante({
        channel: 'voice',
        sessionId: 'llamada-abc',
        text: 'Buenos dias, quisiera una cita para una valoracion.',
        receivedAt: t0,
      }),
    );

    // --- Cuelga. Dos horas despues escribe por WhatsApp, con el telefono
    //     escrito de otra forma: el mismo numero, distinto formato. ---
    const t2h = enElInstante(2 * HORA_MS);
    const porTexto = await env.servicio.handleTurn(
      entrante({
        channel: 'whatsapp',
        patientPhoneE164: '+51 987 654 321',
        text: 'Hola, sigo con lo de la cita del viernes.',
        receivedAt: t2h,
      }),
    );

    // EL MISMO conversation_id, aunque el canal sea distinto.
    expect(porTexto.conversationId).toBe(porVoz.conversationId);
    expect(env.conversaciones.filas).toHaveLength(1);
    expect(env.pacientes.filas).toHaveLength(1);
    expect(env.pacientes.filas[0]!.telefonoE164).toBe('+51987654321');

    // El canal es atributo del MENSAJE, no de la conversacion.
    const conversacion = env.conversaciones.filas[0]!;
    expect(conversacion.canalOrigen).toBe('voice');
    expect(conversacion.ultimoCanal).toBe('whatsapp');

    // Retoma CON EL CONTEXTO: el hilo que ve el modelo trae el turno anterior,
    // leido de la base propia (anti-patron 6: la fuente de verdad es esta base).
    const segundaLlamada = env.claude.llamadas[1]!;
    const hilo = segundaLlamada.messages;
    expect(hilo.length).toBeGreaterThanOrEqual(3);
    expect(hilo[0]!.content).toContain('quisiera una cita para una valoracion');
    expect(hilo[1]!.role).toBe('assistant');
    expect(hilo[1]!.content).toContain('viernes por la manana');
    expect(hilo[hilo.length - 1]!.content).toContain('sigo con lo de la cita');
  });

  it('el cambio de canal se le anuncia al paciente (nota en el bloque 9)', async () => {
    env.claude.responder('Le busco un espacio.').responder('Seguimos por aqui.');

    await env.servicio.handleTurn(
      entrante({ channel: 'voice', receivedAt: enElInstante(0), text: 'Quiero una cita.' }),
    );
    await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', receivedAt: enElInstante(HORA_MS), text: 'Sigo por aqui.' }),
    );

    const bloques1 = partirSystemEnBloques(env.claude.llamadas[0]!.system);
    const bloques2 = partirSystemEnBloques(env.claude.llamadas[1]!.system);

    expect(bloques1[8]).toContain('Sin notas.');
    expect(bloques2[8]).toContain('Anuncia el cambio de canal');
  });

  it('un tercer mensaje por el mismo canal ya no marca cambio de canal', async () => {
    env.claude.responder('Uno.').responder('Dos.').responder('Tres.');

    await env.servicio.handleTurn(entrante({ channel: 'voice', receivedAt: enElInstante(0) }));
    await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', receivedAt: enElInstante(HORA_MS) }),
    );
    await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', receivedAt: enElInstante(2 * HORA_MS) }),
    );

    expect(partirSystemEnBloques(env.claude.llamadas[2]!.system)[8]).toContain('Sin notas.');
  });
});

describe('ventana de continuidad', () => {
  it('dentro de las 72 h reutiliza la conversacion; justo en el limite tambien', async () => {
    env.claude.responder('Uno.').responder('Dos.');

    const primero = await env.servicio.handleTurn(
      entrante({ channel: 'voice', receivedAt: enElInstante(0) }),
    );
    const enElLimite = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', receivedAt: enElInstante(72 * HORA_MS) }),
    );

    expect(enElLimite.conversationId).toBe(primero.conversationId);
    expect(env.conversaciones.filas).toHaveLength(1);
  });

  it('pasada la ventana de 72 h se crea una conversacion NUEVA', async () => {
    env.claude.responder('Uno.').responder('Dos.');

    const primero = await env.servicio.handleTurn(
      entrante({ channel: 'voice', receivedAt: enElInstante(0) }),
    );
    const fuera = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', receivedAt: enElInstante(73 * HORA_MS) }),
    );

    expect(fuera.conversationId).not.toBe(primero.conversationId);
    expect(env.conversaciones.filas).toHaveLength(2);
    // Sigue siendo el MISMO paciente: lo que caduca es la conversacion, no la identidad.
    expect(env.pacientes.filas).toHaveLength(1);
    // Y la conversacion nueva arranca sin historial de la anterior.
    const hilo = env.claude.llamadas[1]!.messages;
    expect(hilo).toHaveLength(1);
    expect(hilo[0]!.role).toBe('user');
  });

  it('la ventana es configurable: con 1 h, dos horas despues ya es otra conversacion', async () => {
    const corto = await crearEntornoDePrueba({ router: { ventanaContinuidadHoras: 1 } });
    corto.claude.responder('Uno.').responder('Dos.');
    const fecha0 = new Date(T0);
    corto.conversaciones.reloj = () => fecha0;

    const primero = await corto.servicio.handleTurn({
      clinicId: corto.clinica.id,
      patientPhoneE164: '+51987654321',
      text: 'Hola',
      channel: 'voice',
      receivedAt: fecha0,
    });

    const fecha2 = new Date(T0.getTime() + 2 * HORA_MS);
    corto.conversaciones.reloj = () => fecha2;
    const segundo = await corto.servicio.handleTurn({
      clinicId: corto.clinica.id,
      patientPhoneE164: '+51987654321',
      text: 'Hola de nuevo',
      channel: 'whatsapp',
      receivedAt: fecha2,
    });

    expect(segundo.conversationId).not.toBe(primero.conversationId);
  });
});

describe('normalizacion del telefono (libphonenumber-js, region PE)', () => {
  it('un numero local sin prefijo internacional es el mismo paciente', async () => {
    env.claude.responder('Uno.').responder('Dos.');

    const conPrefijo = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', patientPhoneE164: '+51987654321', receivedAt: enElInstante(0) }),
    );
    const sinPrefijo = await env.servicio.handleTurn(
      entrante({ channel: 'voice', patientPhoneE164: '987654321', receivedAt: enElInstante(HORA_MS) }),
    );

    expect(sinPrefijo.conversationId).toBe(conPrefijo.conversationId);
    expect(env.pacientes.filas).toHaveLength(1);
  });

  it('un telefono que no se puede normalizar corta el turno con un error tipado', async () => {
    await expect(
      env.servicio.handleTurn(entrante({ channel: 'whatsapp', patientPhoneE164: '123' })),
    ).rejects.toMatchObject({ name: 'MessageRouterError', codigo: 'telefono_invalido' });
  });

  it('una clinica desconocida corta el turno con un error tipado', async () => {
    await expect(
      env.servicio.handleTurn(
        entrante({ channel: 'whatsapp', clinicId: '99999999-9999-4999-8999-999999999999' }),
      ),
    ).rejects.toMatchObject({ name: 'MessageRouterError', codigo: 'clinica_desconocida' });
  });
});

describe('aislamiento entre pacientes', () => {
  it('dos telefonos distintos de la misma clinica no comparten conversacion', async () => {
    env.claude.responder('Uno.').responder('Dos.');

    const uno = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', patientPhoneE164: '+51987654321', receivedAt: enElInstante(0) }),
    );
    const otro = await env.servicio.handleTurn(
      entrante({ channel: 'whatsapp', patientPhoneE164: '+51987000222', receivedAt: enElInstante(0) }),
    );

    expect(otro.conversationId).not.toBe(uno.conversationId);
    expect(env.pacientes.filas).toHaveLength(2);
    expect(env.claude.llamadas[1]!.messages).toHaveLength(1);
  });
});

describe('contador de fallos de comprension', () => {
  it('se reconstruye del historial y a los dos fallos el prompt ordena la salida alternativa', async () => {
    env.claude
      .responder('Disculpe, no le entendi bien.')
      .responder('Disculpe, no le entendi. Me lo puede repetir?')
      .responder('Le paso con alguien del equipo.');

    await env.servicio.handleTurn(
      entrante({ channel: 'voice', text: 'brrr', receivedAt: enElInstante(0) }),
    );
    await env.servicio.handleTurn(
      entrante({ channel: 'voice', text: 'brrr', receivedAt: enElInstante(60_000) }),
    );
    await env.servicio.handleTurn(
      entrante({ channel: 'voice', text: 'brrr', receivedAt: enElInstante(120_000) }),
    );

    const bloque9DelTercero = partirSystemEnBloques(env.claude.llamadas[2]!.system)[8]!;
    expect(bloque9DelTercero).toContain('2 fallos de comprension consecutivos');
    expect(bloque9DelTercero).toContain('criterio 4 de escalamiento');
  });

  it('un turno comprendido devuelve el contador a cero', async () => {
    env.claude
      .responder('Disculpe, no le entendi bien.')
      .responder('Perfecto, le busco un espacio el viernes.')
      .responder('Confirmado el viernes entonces.');

    await env.servicio.handleTurn(entrante({ channel: 'voice', receivedAt: enElInstante(0) }));
    await env.servicio.handleTurn(entrante({ channel: 'voice', receivedAt: enElInstante(60_000) }));
    await env.servicio.handleTurn(entrante({ channel: 'voice', receivedAt: enElInstante(120_000) }));

    expect(partirSystemEnBloques(env.claude.llamadas[2]!.system)[8]).toContain('Sin notas.');
  });
});
