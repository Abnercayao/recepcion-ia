/**
 * Tests de src/channels/voice/system-tools.mapper.ts.
 *
 * Lo que se protege aqui es la distincion que sostiene el diseno: las
 * herramientas de NEGOCIO no salen nunca del nucleo (anti-patron 3) y las de
 * SISTEMA se emiten con los nombres de parametro EXACTOS del proveedor
 * (docs/contrato-elevenlabs.md §4).
 *
 * Los nombres se comprueban con `Object.keys`, no con `toMatchObject`: un test
 * que solo mira que el valor este presente no detecta que ademas viaje una
 * clave de mas, y una clave inventada en la telefonia es un tool call que
 * ElevenLabs rechaza en mitad de una llamada.
 */
import { describe, expect, it } from 'vitest';
import {
  MOTIVO_DE_FIN_DE_LLAMADA,
  argumentosJson,
  endCallArgsSchema,
  esHerramientaDeNegocio,
  esHerramientaDeSistema,
  languageDetectionArgsSchema,
  mapearEscalacion,
  mapearFinDeLlamada,
  mapearToolCallDeSistema,
  resumenDeRespaldo,
  skipTurnArgsSchema,
  transferToNumberArgsSchema,
} from '../../src/channels/voice/system-tools.mapper.js';
import type { EscalationRequest } from '../../src/core/types/index.js';

const WHITELIST = ['+51987000111', '+51987000222'];

function escalacion(over: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    reason: 'urgencia',
    priority: 'urgente',
    summaryForAgent: 'URGENCIA detectada por la capa 3. Paciente refiere dolor intenso tras extraccion.',
    messageForPatient: 'Le estoy pasando con una persona del equipo en este momento.',
    ...over,
  };
}

describe('negocio vs sistema', () => {
  it('las cinco de negocio se ejecutan dentro del nucleo y NO son de sistema', () => {
    for (const nombre of ['consultar_agenda', 'crear_cita', 'guardar_lead', 'escalar_humano', 'consultar_rag']) {
      expect(esHerramientaDeNegocio(nombre)).toBe(true);
      expect(esHerramientaDeSistema(nombre)).toBe(false);
    }
  });

  it('las cuatro de sistema son las que ejecuta la telefonia', () => {
    for (const nombre of ['transfer_to_number', 'end_call', 'language_detection', 'skip_turn']) {
      expect(esHerramientaDeSistema(nombre)).toBe(true);
      expect(esHerramientaDeNegocio(nombre)).toBe(false);
    }
  });

  it('un nombre desconocido no es ni una cosa ni la otra', () => {
    expect(esHerramientaDeSistema('borrar_historial')).toBe(false);
    expect(esHerramientaDeNegocio('borrar_historial')).toBe(false);
  });
});

describe('nombres de parametro exactos (docs/contrato-elevenlabs.md §4)', () => {
  it('transfer_to_number: transfer_number, client_message, agent_message (req) y reason (opt)', () => {
    const args = transferToNumberArgsSchema.parse({
      transfer_number: '+51987000111',
      client_message: 'Le paso con una persona.',
      agent_message: 'Resumen para recepcion.',
      reason: 'urgencia',
    });
    expect(Object.keys(args).sort()).toEqual(
      ['agent_message', 'client_message', 'reason', 'transfer_number'].sort(),
    );
    // los tres requeridos lo son de verdad
    for (const clave of ['transfer_number', 'client_message', 'agent_message']) {
      const parcial: Record<string, string> = {
        transfer_number: '+51987000111',
        client_message: 'a',
        agent_message: 'b',
      };
      delete parcial[clave];
      expect(transferToNumberArgsSchema.safeParse(parcial).success).toBe(false);
    }
  });

  it('end_call: reason (req) y message (opt)', () => {
    expect(endCallArgsSchema.safeParse({ reason: 'fin' }).success).toBe(true);
    expect(endCallArgsSchema.safeParse({ message: 'adios' }).success).toBe(false);
    expect(Object.keys(endCallArgsSchema.parse({ reason: 'fin', message: 'adios' })).sort()).toEqual([
      'message',
      'reason',
    ]);
  });

  it('language_detection: reason y language, ambos requeridos', () => {
    expect(languageDetectionArgsSchema.safeParse({ reason: 'x', language: 'es' }).success).toBe(true);
    expect(languageDetectionArgsSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(languageDetectionArgsSchema.safeParse({ language: 'es' }).success).toBe(false);
  });

  it('skip_turn: reason opcional', () => {
    expect(skipTurnArgsSchema.safeParse({}).success).toBe(true);
    expect(skipTurnArgsSchema.safeParse({ reason: 'el paciente sigue hablando' }).success).toBe(true);
  });
});

describe('EscalationRequest -> transfer_to_number', () => {
  it('CRITERIO DE LA FASE 4: numero en lista blanca y agent_message NO vacio', () => {
    const resultado = mapearEscalacion(escalacion({ transferNumber: '+51987000222' }), WHITELIST);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const args = resultado.invocacion.args;
    expect(resultado.invocacion.name).toBe('transfer_to_number');
    expect(WHITELIST).toContain(args.transfer_number);
    expect(args.agent_message.trim()).not.toBe('');
    // Sin claves de mas ni de menos.
    expect(Object.keys(args).sort()).toEqual(
      ['agent_message', 'client_message', 'reason', 'transfer_number'].sort(),
    );
  });

  it('client_message = messageForPatient y agent_message = summaryForAgent, literalmente', () => {
    const request = escalacion({ transferNumber: '+51987000111' });
    const resultado = mapearEscalacion(request, WHITELIST);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.invocacion.args.client_message).toBe(request.messageForPatient);
    expect(resultado.invocacion.args.agent_message).toBe(request.summaryForAgent);
    expect(resultado.invocacion.args.reason).toBe('urgencia');
  });

  it('un numero FUERA de la lista blanca no se transfiere jamas', () => {
    const resultado = mapearEscalacion(escalacion({ transferNumber: '+51900000000' }), WHITELIST);
    expect(resultado).toEqual({ ok: false, motivo: 'fuera_de_lista_blanca' });
  });

  it('sin numero en la peticion se usa el PRIMERO de la lista blanca (decision declarada)', () => {
    const resultado = mapearEscalacion(escalacion(), WHITELIST);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.invocacion.args.transfer_number).toBe('+51987000111');
  });

  it('con la lista blanca vacia no hay transferencia posible', () => {
    expect(mapearEscalacion(escalacion({ transferNumber: '+51987000111' }), [])).toEqual({
      ok: false,
      motivo: 'fuera_de_lista_blanca',
    });
    expect(mapearEscalacion(escalacion(), [])).toEqual({ ok: false, motivo: 'sin_numero' });
  });

  it('agent_message nunca sale vacio: si el nucleo no trajo resumen, se genera uno', () => {
    const resultado = mapearEscalacion(escalacion({ summaryForAgent: '   ' }), WHITELIST);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.invocacion.args.agent_message.trim()).not.toBe('');
    expect(resultado.invocacion.args.agent_message).toContain('urgencia');
  });

  it('client_message tampoco sale vacio', () => {
    const resultado = mapearEscalacion(escalacion({ messageForPatient: '' }), WHITELIST);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.invocacion.args.client_message.trim()).not.toBe('');
  });

  it('el resumen de respaldo nombra motivo y prioridad', () => {
    const texto = resumenDeRespaldo(escalacion({ reason: 'reclamo', priority: 'normal' }));
    expect(texto).toContain('reclamo');
    expect(texto).toContain('normal');
  });

  it('lo que se emite valida contra el esquema del proveedor', () => {
    const resultado = mapearEscalacion(escalacion({ transferNumber: '+51987000111' }), WHITELIST);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(transferToNumberArgsSchema.safeParse(resultado.invocacion.args).success).toBe(true);
    expect(JSON.parse(argumentosJson(resultado.invocacion))).toEqual(resultado.invocacion.args);
  });
});

describe('otras herramientas de sistema', () => {
  it('mapearFinDeLlamada produce un end_call con reason y, si hay, message', () => {
    expect(mapearFinDeLlamada()).toEqual({ name: 'end_call', args: { reason: MOTIVO_DE_FIN_DE_LLAMADA } });
    expect(mapearFinDeLlamada('Gracias por llamar.')).toEqual({
      name: 'end_call',
      args: { reason: MOTIVO_DE_FIN_DE_LLAMADA, message: 'Gracias por llamar.' },
    });
    expect(mapearFinDeLlamada('   ').args.message).toBeUndefined();
  });

  it('mapearToolCallDeSistema ignora las herramientas de negocio', () => {
    expect(mapearToolCallDeSistema('crear_cita', { fecha: '2026-08-01' })).toBeUndefined();
    expect(mapearToolCallDeSistema('escalar_humano', { reason: 'urgencia' })).toBeUndefined();
  });

  it('mapearToolCallDeSistema rechaza argumentos que no cumplen el contrato (anti-patron 4)', () => {
    expect(mapearToolCallDeSistema('transfer_to_number', { transfer_number: '+51987000111' })).toBeUndefined();
    expect(mapearToolCallDeSistema('end_call', {})).toBeUndefined();
    expect(mapearToolCallDeSistema('language_detection', { language: 'es' })).toBeUndefined();
  });

  it('mapearToolCallDeSistema acepta lo valido y conserva los nombres exactos', () => {
    expect(mapearToolCallDeSistema('skip_turn', {})).toEqual({ name: 'skip_turn', args: {} });
    expect(mapearToolCallDeSistema('language_detection', { reason: 'el paciente hablo en ingles', language: 'en' })).toEqual({
      name: 'language_detection',
      args: { reason: 'el paciente hablo en ingles', language: 'en' },
    });
  });
});
