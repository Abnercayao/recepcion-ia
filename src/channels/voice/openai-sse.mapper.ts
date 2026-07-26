/**
 * openai-sse.mapper.ts
 *
 * Traduccion pura a Server-Sent Events con forma OpenAI. Sin estado, sin E/S,
 * sin ninguna decision de negocio: entra un dato, sale una cadena.
 *
 * Lo CONFIRMADO por el proveedor (docs/contrato-elevenlabs.md §3):
 *   · cada chunk se escribe como  `data: {json}\n\n`
 *   · el cierre es               `data: [DONE]\n\n`
 *   · la forma del chunk es `chat.completion.chunk` con
 *     `choices[0].delta.content` y `finish_reason`.
 *
 * ===========================================================================
 * ASUNCION AISLADA — STREAMING DE `tool_calls` (NO DOCUMENTADO)
 * ===========================================================================
 * `docs/contrato-elevenlabs.md` §3 lo dice literalmente: «Streaming de
 * `tool_calls`: NO DOCUMENTADO. La documentacion solo muestra ejemplos
 * estaticos completos». Como la implementacion de referencia del proveedor es
 * un proxy literal del SDK de OpenAI, ASUMIMOS el formato de streaming de
 * OpenAI:
 *
 *   1. primer fragmento: `index` + `id` + `type:'function'` + `function.name`
 *      (con `function.arguments` vacio);
 *   2. fragmentos siguientes: `index` + `function.arguments` INCREMENTAL
 *      (trozos que, concatenados, forman el JSON completo);
 *   3. cierre del turno con `finish_reason: "tool_calls"`.
 *
 * TODA esa asuncion vive en `fragmentosDeToolCall` y en `chunkDeCierre`. Si el
 * proveedor resulta esperar otra cosa (p. ej. el objeto completo en un solo
 * fragmento, o `arguments` como objeto en vez de string JSON), corregirlo es un
 * cambio LOCAL a este archivo: ni el controller ni el mapper de system tools
 * saben como se serializa.
 * ===========================================================================
 */
import { randomUUID } from 'node:crypto';
import type {
  ContextoDeChunk,
  OpenAiChatCompletionChunk,
  OpenAiFinishReason,
  OpenAiToolCallDelta,
} from './voice.types.js';

/** Cierre literal del stream. CONFIRMADO por el proveedor. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** Prefijo de los ids de completion, igual que OpenAI (`chatcmpl-...`). */
export function crearIdDeCompletion(): string {
  return `chatcmpl-${randomUUID()}`;
}

/** Id de un tool call. OpenAI usa `call_...`; el proveedor no documenta ninguna forma. */
export function crearIdDeToolCall(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Serializa un chunk al formato de linea SSE. Es el UNICO sitio donde se
 * escribe el `data: ` y el doble salto de linea.
 */
export function serializarChunk(chunk: OpenAiChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function chunkBase(ctx: ContextoDeChunk): Omit<OpenAiChatCompletionChunk, 'choices'> {
  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
  };
}

/**
 * Chunk de texto. Se emite `delta.content` a secas, tal como muestra el
 * ejemplo oficial: NO se antepone un chunk con `delta.role` aunque el SDK de
 * OpenAI lo haga. Es la lectura literal de lo documentado; si en la Fase 5 el
 * agente se queja de un delta sin rol, este es el sitio donde anadirlo.
 */
export function chunkDeTexto(ctx: ContextoDeChunk, delta: string): OpenAiChatCompletionChunk {
  return {
    ...chunkBase(ctx),
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
}

/** Chunk final del turno. `finish_reason` es lo unico que lleva. */
export function chunkDeCierre(
  ctx: ContextoDeChunk,
  finishReason: Exclude<OpenAiFinishReason, null>,
): OpenAiChatCompletionChunk {
  return {
    ...chunkBase(ctx),
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

export interface ToolCallParaStream {
  /** Posicion dentro de `tool_calls[]` del mensaje. 0 para el primero del turno. */
  index: number;
  /** Id del tool call. Si se omite, se genera. */
  id?: string;
  name: string;
  /** Argumentos YA serializados a JSON. Este mapper no decide su contenido. */
  argumentsJson: string;
}

/**
 * Fragmentos SSE de UN tool call, en el formato de streaming de OpenAI.
 * Ver el bloque «ASUNCION AISLADA» de la cabecera: esto es una inferencia
 * nuestra, no un contrato del proveedor.
 *
 * Se emiten DOS fragmentos (nombre primero, argumentos despues) en vez de uno
 * solo con todo: es lo que hace un stream real de OpenAI, y es justamente la
 * forma que un consumidor incremental podria no tolerar si se le manda de
 * golpe. Preferimos parecernos al original.
 */
export function fragmentosDeToolCall(
  ctx: ContextoDeChunk,
  tool: ToolCallParaStream,
): OpenAiChatCompletionChunk[] {
  const id = tool.id ?? crearIdDeToolCall();

  const apertura: OpenAiToolCallDelta = {
    index: tool.index,
    id,
    type: 'function',
    function: { name: tool.name, arguments: '' },
  };
  const argumentos: OpenAiToolCallDelta = {
    index: tool.index,
    function: { arguments: tool.argumentsJson },
  };

  return [
    { ...chunkBase(ctx), choices: [{ index: 0, delta: { tool_calls: [apertura] }, finish_reason: null }] },
    { ...chunkBase(ctx), choices: [{ index: 0, delta: { tool_calls: [argumentos] }, finish_reason: null }] },
  ];
}

/** Atajo: los fragmentos de un tool call ya serializados como lineas SSE. */
export function lineasDeToolCall(ctx: ContextoDeChunk, tool: ToolCallParaStream): string[] {
  return fragmentosDeToolCall(ctx, tool).map(serializarChunk);
}
