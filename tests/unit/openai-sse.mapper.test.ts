/**
 * Tests de src/channels/voice/openai-sse.mapper.ts.
 *
 * Dos cosas distintas se comprueban aqui, y conviene no confundirlas:
 *
 *  1. Lo CONFIRMADO contra la documentacion del proveedor
 *     (docs/contrato-elevenlabs.md §3): el marco `data: {json}\n\n`, el cierre
 *     `data: [DONE]\n\n` y la forma `chat.completion.chunk`. Si estos tests se
 *     caen, es que rompimos el contrato.
 *
 *  2. La ASUNCION sobre el streaming de `tool_calls`, que el proveedor NO
 *     documenta. Estos tests no demuestran que el formato sea correcto: fijan
 *     el que decidimos (el de OpenAI) para que un cambio sea deliberado y
 *     localizado en un solo archivo.
 */
import { describe, expect, it } from 'vitest';
import {
  SSE_DONE,
  chunkDeCierre,
  chunkDeTexto,
  crearIdDeCompletion,
  crearIdDeToolCall,
  fragmentosDeToolCall,
  lineasDeToolCall,
  serializarChunk,
} from '../../src/channels/voice/openai-sse.mapper.js';
import type { ContextoDeChunk } from '../../src/channels/voice/voice.types.js';

const CTX: ContextoDeChunk = {
  id: 'chatcmpl-fijo',
  model: 'recepcion-ia-voice',
  created: 1_780_000_000,
};

describe('marco SSE (confirmado por el proveedor)', () => {
  it('serializa como `data: {json}\\n\\n`, con un unico salto doble al final', () => {
    const linea = serializarChunk(chunkDeTexto(CTX, 'hola'));

    expect(linea.startsWith('data: ')).toBe(true);
    expect(linea.endsWith('\n\n')).toBe(true);
    expect(linea.slice(0, -2)).not.toContain('\n'); // el JSON va en UNA linea
    expect(JSON.parse(linea.slice('data: '.length))).toMatchObject({ object: 'chat.completion.chunk' });
  });

  it('el cierre es exactamente `data: [DONE]\\n\\n`', () => {
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
  });

  it('un delta de texto viaja en choices[0].delta.content con finish_reason null', () => {
    expect(chunkDeTexto(CTX, 'buenos dias')).toEqual({
      id: 'chatcmpl-fijo',
      object: 'chat.completion.chunk',
      created: 1_780_000_000,
      model: 'recepcion-ia-voice',
      choices: [{ index: 0, delta: { content: 'buenos dias' }, finish_reason: null }],
    });
  });

  it('el chunk de cierre lleva delta vacio y el finish_reason pedido', () => {
    expect(chunkDeCierre(CTX, 'stop').choices[0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: 'stop',
    });
    expect(chunkDeCierre(CTX, 'tool_calls').choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('un delta de texto no falsea contenido: una cadena vacia sigue siendo cadena vacia', () => {
    expect(chunkDeTexto(CTX, '').choices[0]?.delta).toEqual({ content: '' });
  });

  it('ids con prefijo de OpenAI y unicos entre llamadas', () => {
    const a = crearIdDeCompletion();
    const b = crearIdDeCompletion();
    expect(a.startsWith('chatcmpl-')).toBe(true);
    expect(a).not.toBe(b);

    const t = crearIdDeToolCall();
    expect(t.startsWith('call_')).toBe(true);
    expect(t).not.toBe(crearIdDeToolCall());
  });
});

describe('streaming de tool_calls (ASUNCION nuestra, no documentada)', () => {
  it('primer fragmento: index + id + function.name; segundo: index + arguments incrementales', () => {
    const [apertura, argumentos] = fragmentosDeToolCall(CTX, {
      index: 0,
      id: 'call_fijo',
      name: 'transfer_to_number',
      argumentsJson: '{"transfer_number":"+51987000111"}',
    });

    expect(apertura?.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_fijo',
        type: 'function',
        function: { name: 'transfer_to_number', arguments: '' },
      },
    ]);

    const segundo = argumentos?.choices[0]?.delta.tool_calls?.[0];
    expect(segundo).toEqual({
      index: 0,
      function: { arguments: '{"transfer_number":"+51987000111"}' },
    });
    // El segundo fragmento NO repite id ni type: es lo que hace OpenAI y lo que
    // permite reensamblar por `index`.
    expect(segundo).not.toHaveProperty('id');
    expect(segundo).not.toHaveProperty('type');
  });

  it('ningun fragmento de tool_call cierra el turno por su cuenta', () => {
    for (const chunk of fragmentosDeToolCall(CTX, { index: 0, name: 'end_call', argumentsJson: '{}' })) {
      expect(chunk.choices[0]?.finish_reason).toBeNull();
    }
  });

  it('genera un id si no se le da uno', () => {
    const [apertura] = fragmentosDeToolCall(CTX, { index: 1, name: 'skip_turn', argumentsJson: '{}' });
    const tc = apertura?.choices[0]?.delta.tool_calls?.[0];
    expect(tc?.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(tc?.index).toBe(1);
  });

  it('los argumentos viajan como STRING JSON, no como objeto', () => {
    const [, argumentos] = fragmentosDeToolCall(CTX, {
      index: 0,
      name: 'end_call',
      argumentsJson: JSON.stringify({ reason: 'fin' }),
    });
    const bruto = argumentos?.choices[0]?.delta.tool_calls?.[0]?.function?.arguments;
    expect(typeof bruto).toBe('string');
    expect(JSON.parse(bruto as string)).toEqual({ reason: 'fin' });
  });

  it('lineasDeToolCall devuelve los dos fragmentos ya enmarcados como SSE', () => {
    const lineas = lineasDeToolCall(CTX, { index: 0, name: 'end_call', argumentsJson: '{}' });
    expect(lineas).toHaveLength(2);
    for (const linea of lineas) {
      expect(linea.startsWith('data: ')).toBe(true);
      expect(linea.endsWith('\n\n')).toBe(true);
    }
  });
});
