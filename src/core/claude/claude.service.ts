/**
 * Implementacion de `ClaudePort` sobre `@anthropic-ai/sdk`.
 *
 * Es el UNICO punto del sistema que conoce el SDK del proveedor. Ese
 * encapsulamiento es lo que convierte «cambiar de modelo» en configuracion y
 * no en reescritura (decision §3.1.2.B). El resto del nucleo solo ve
 * `ClaudeStreamChunk`, que ya esta normalizado y no es el formato del SDK.
 *
 * NOTA DE DEPENDENCIAS: este archivo vive en `core/` y depende de un paquete
 * externo. No rompe la regla del contrato —lo prohibido es que `core/` importe
 * de `channels/` o de `infra/`—, pero es deliberado que la superficie del SDK
 * no salga de aqui.
 */
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import pRetry from 'p-retry';
import type {
  ClaudeCallOptions,
  ClaudePort,
  ClaudeStreamChunk,
  ClaudeToolUse,
  Logger,
} from '../types/index.js';

/** Solo lo que el servicio necesita. No es el `Config` completo a proposito. */
export interface ClaudeServiceConfig {
  apiKey: string;
  /** Modelo por defecto cuando la llamada no especifica uno. */
  modelPorDefecto: string;
  maxTokens: number;
  temperature: number;
  /** Reintentos ADEMAS del primer intento. */
  reintentos?: number;
  /** Timeout por peticion HTTP, en milisegundos. */
  timeoutMs?: number;
}

export interface ClaudeServiceDeps {
  config: ClaudeServiceConfig;
  logger: Logger;
  /** Cliente ya construido. Existe para los tests: nunca se usa en produccion. */
  client?: Anthropic;
}

/** Resultado que el llamador devuelve al bucle de herramientas. */
export interface ToolLoopResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

const REINTENTOS_POR_DEFECTO = 2;
const TIMEOUT_POR_DEFECTO_MS = 30_000;
const MAX_ITERACIONES_TOOL_LOOP = 5;

/**
 * Las familias de modelo mas recientes RECHAZAN `temperature` con un 400.
 * El modelo llega por variable de entorno, asi que se decide en tiempo de
 * ejecucion: mandar el parametro a ciegas es un error 400 en produccion.
 */
export function admiteTemperature(model: string): boolean {
  return !/(opus-5|opus-4-7|opus-4-8|sonnet-5|fable|mythos)/i.test(model);
}

/** Reintentable: caida de red, limite de tasa, o fallo del lado del proveedor. */
export function esReintentable(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true;
  if (error instanceof APIError) {
    const status = error.status;
    if (typeof status !== 'number') return true; // sin status es fallo de transporte
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return false;
}

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type MessageParam = Anthropic.Messages.MessageParam;

export class ClaudeService implements ClaudePort {
  private readonly client: Anthropic;
  private readonly logger: Logger;
  private readonly config: ClaudeServiceConfig;

  constructor(deps: ClaudeServiceDeps) {
    this.config = deps.config;
    this.logger = deps.logger.child({ componente: 'claude.service' });
    this.client =
      deps.client ??
      new Anthropic({
        apiKey: deps.config.apiKey,
        timeout: deps.config.timeoutMs ?? TIMEOUT_POR_DEFECTO_MS,
        // El reintento lo gobierna p-retry, con nuestra politica y nuestro log.
        maxRetries: 0,
      });
  }

  // -------------------------------------------------------------------------
  // ClaudePort
  // -------------------------------------------------------------------------

  async complete(opts: ClaudeCallOptions): Promise<{ text: string; toolUses: ClaudeToolUse[] }> {
    const params = this.construirParams(opts);
    const inicio = Date.now();

    const respuesta = await this.conReintentos('complete', () =>
      this.client.messages.create({ ...params, stream: false }),
    );

    const text = respuesta.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolUses = respuesta.content
      .filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      }));

    this.logger.debug(
      {
        modelo: params.model,
        tokensIn: respuesta.usage.input_tokens,
        tokensOut: respuesta.usage.output_tokens,
        latenciaMs: Date.now() - inicio,
        stopReason: respuesta.stop_reason,
      },
      'complete',
    );

    return { text, toolUses };
  }

  /**
   * Streaming normalizado. Obligatorio para el canal de voz: sin el, la
   * latencia percibida arruina la conversacion (especificacion §4).
   *
   * El reintento cubre SOLO el establecimiento de la conexion. Una vez que ha
   * salido el primer token no se reintenta: se duplicaria audio ya emitido.
   */
  async *stream(opts: ClaudeCallOptions): AsyncIterable<ClaudeStreamChunk> {
    const params = this.construirParams(opts);
    yield* this.streamDeUnaLlamada(params, { bloques: [] });
  }

  // -------------------------------------------------------------------------
  // Bucle de herramientas
  // -------------------------------------------------------------------------

  /**
   * Igual que `stream()`, pero cierra el bucle de herramientas: cuando el
   * modelo pide una herramienta, se ejecuta con `ejecutar`, se devuelve el
   * resultado y se vuelve a llamar al modelo, hasta que deje de pedir.
   *
   * No forma parte de `ClaudePort` porque el puerto no conoce herramientas de
   * negocio: quien las ejecuta es el `ConversationService`, que es quien pasa
   * `ejecutar`. Aqui solo se orquesta el ida y vuelta.
   *
   * El tope de iteraciones no es decorativo: sin el, un modelo que insiste en
   * llamar a la misma herramienta deja al paciente escuchando silencio.
   */
  async *streamLoop(
    opts: ClaudeCallOptions,
    ejecutar: (toolUse: ClaudeToolUse) => Promise<ToolLoopResult>,
    maxIteraciones = MAX_ITERACIONES_TOOL_LOOP,
  ): AsyncIterable<ClaudeStreamChunk> {
    const params = this.construirParams(opts);
    const mensajes: MessageParam[] = [...params.messages];
    let tokensIn = 0;
    let tokensOut = 0;

    for (let iteracion = 0; iteracion < maxIteraciones; iteracion += 1) {
      const acumulado: { bloques: ContentBlockParam[] } = { bloques: [] };
      let stopReason = 'end_turn';
      const herramientas: ClaudeToolUse[] = [];

      for await (const chunk of this.streamDeUnaLlamada(
        { ...params, messages: mensajes },
        acumulado,
      )) {
        if (chunk.type === 'end') {
          stopReason = chunk.stopReason;
          tokensIn += chunk.tokensIn;
          tokensOut += chunk.tokensOut;
          continue; // el `end` real se emite al terminar el bucle
        }
        if (chunk.type === 'tool_use') herramientas.push(chunk.toolUse);
        yield chunk;
      }

      if (stopReason !== 'tool_use' || herramientas.length === 0) {
        yield { type: 'end', stopReason, tokensIn, tokensOut };
        return;
      }

      mensajes.push({ role: 'assistant', content: acumulado.bloques });

      const resultados: ContentBlockParam[] = [];
      for (const herramienta of herramientas) {
        const resultado = await ejecutar(herramienta);
        resultados.push({
          type: 'tool_result',
          tool_use_id: resultado.toolUseId,
          content: resultado.content,
          is_error: resultado.isError ?? false,
        });
      }
      // Todos los resultados van en UN solo mensaje de usuario: separarlos
      // ensena al modelo a dejar de pedir herramientas en paralelo.
      mensajes.push({ role: 'user', content: resultados });
    }

    this.logger.warn(
      { maxIteraciones },
      'el bucle de herramientas agoto las iteraciones; se cierra el turno',
    );
    yield { type: 'end', stopReason: 'max_tool_iterations', tokensIn, tokensOut };
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Una sola llamada en streaming, traducida a `ClaudeStreamChunk`.
   * `acumulado.bloques` se rellena con lo que produjo el modelo, para poder
   * reenviarlo como turno de assistant en el bucle de herramientas.
   */
  private async *streamDeUnaLlamada(
    params: Anthropic.Messages.MessageCreateParams,
    acumulado: { bloques: ContentBlockParam[] },
  ): AsyncIterable<ClaudeStreamChunk> {
    const inicio = Date.now();
    const stream = await this.conReintentos('stream', () =>
      this.client.messages.create({ ...params, stream: true }),
    );

    // Acumuladores por indice de bloque: el JSON de una herramienta llega
    // troceado en `input_json_delta` y no es valido hasta el cierre del bloque.
    const enCurso = new Map<number, { id: string; name: string; json: string }>();
    const textoPorIndice = new Map<number, string>();
    let tokensIn = 0;
    let tokensOut = 0;
    let stopReason = 'end_turn';
    let emitidoEnd = false;

    for await (const evento of stream) {
      switch (evento.type) {
        case 'message_start': {
          tokensIn = evento.message.usage.input_tokens;
          break;
        }
        case 'content_block_start': {
          const bloque = evento.content_block;
          if (bloque.type === 'tool_use') {
            enCurso.set(evento.index, { id: bloque.id, name: bloque.name, json: '' });
          } else if (bloque.type === 'text') {
            textoPorIndice.set(evento.index, bloque.text ?? '');
            if (bloque.text) yield { type: 'text', delta: bloque.text };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = evento.delta;
          if (delta.type === 'text_delta') {
            textoPorIndice.set(evento.index, (textoPorIndice.get(evento.index) ?? '') + delta.text);
            yield { type: 'text', delta: delta.text };
          } else if (delta.type === 'input_json_delta') {
            const parcial = enCurso.get(evento.index);
            if (parcial) parcial.json += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const parcial = enCurso.get(evento.index);
          if (parcial) {
            enCurso.delete(evento.index);
            const input = this.parsearInput(parcial.json, parcial.name);
            acumulado.bloques.push({
              type: 'tool_use',
              id: parcial.id,
              name: parcial.name,
              input,
            });
            yield { type: 'tool_use', toolUse: { id: parcial.id, name: parcial.name, input } };
            break;
          }
          const texto = textoPorIndice.get(evento.index);
          if (texto !== undefined) {
            textoPorIndice.delete(evento.index);
            if (texto !== '') acumulado.bloques.push({ type: 'text', text: texto });
          }
          break;
        }
        case 'message_delta': {
          stopReason = evento.delta.stop_reason ?? stopReason;
          tokensOut = evento.usage.output_tokens ?? tokensOut;
          break;
        }
        case 'message_stop': {
          emitidoEnd = true;
          this.logger.debug(
            {
              modelo: params.model,
              tokensIn,
              tokensOut,
              latenciaMs: Date.now() - inicio,
              stopReason,
            },
            'stream',
          );
          yield { type: 'end', stopReason, tokensIn, tokensOut };
          break;
        }
        default:
          break;
      }
    }

    // Un stream que se corta sin `message_stop` tiene que cerrar igual: quien
    // consume esto esta sintetizando voz y necesita saber que ya no viene mas.
    if (!emitidoEnd) {
      this.logger.warn({ modelo: params.model }, 'el stream termino sin message_stop');
      yield { type: 'end', stopReason: 'incomplete', tokensIn, tokensOut };
    }
  }

  /** El JSON de la herramienta puede llegar vacio o roto. Nunca se confia en el. */
  private parsearInput(json: string, herramienta: string): Record<string, unknown> {
    if (json.trim() === '') return {};
    try {
      const parseado: unknown = JSON.parse(json);
      if (typeof parseado === 'object' && parseado !== null && !Array.isArray(parseado)) {
        return parseado as Record<string, unknown>;
      }
      return {};
    } catch {
      // No se lanza: la herramienta valida con Zod y rechazara el objeto vacio
      // con un mensaje que el modelo puede entender y corregir.
      this.logger.warn({ herramienta }, 'argumentos de herramienta con JSON invalido');
      return {};
    }
  }

  private construirParams(opts: ClaudeCallOptions): Anthropic.Messages.MessageCreateParams {
    const model = opts.model ?? this.config.modelPorDefecto;
    const params: Anthropic.Messages.MessageCreateParams = {
      model,
      max_tokens: opts.maxTokens ?? this.config.maxTokens,
      system: this.construirSystem(opts),
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (opts.tools && opts.tools.length > 0) {
      params.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      }));
    }
    const temperature = opts.temperature ?? this.config.temperature;
    if (admiteTemperature(model)) {
      params.temperature = temperature;
    }
    return params;
  }

  /**
   * `system` como uno o dos bloques, segun haya prefijo cacheable.
   *
   * Con prefijo, el bloque estable lleva `cache_control` y el resto —contexto
   * RAG, variables de sesion y estilo del canal— va aparte, porque cambia en
   * cada turno y cachearlo seria un fallo de cache garantizado.
   *
   * El ahorro no es solo entre turnos: dentro de UN turno, el bucle de
   * herramientas vuelve a llamar al modelo con el mismo `system` cada vez.
   */
  private construirSystem(
    opts: ClaudeCallOptions,
  ): Anthropic.Messages.MessageCreateParams['system'] {
    const prefijo = opts.systemPrefijoCacheable;
    if (!prefijo || prefijo.length === 0 || !opts.system.startsWith(prefijo)) {
      return opts.system;
    }

    const resto = opts.system.slice(prefijo.length);
    const bloques: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: prefijo, cache_control: { type: 'ephemeral' } },
    ];
    if (resto.length > 0) bloques.push({ type: 'text', text: resto });
    return bloques;
  }

  private conReintentos<T>(operacion: string, fn: () => Promise<T>): Promise<T> {
    const reintentos = this.config.reintentos ?? REINTENTOS_POR_DEFECTO;
    return pRetry(fn, {
      retries: reintentos,
      minTimeout: 400,
      factor: 2,
      shouldRetry: ({ error }) => esReintentable(error),
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
        this.logger.warn(
          {
            operacion,
            intento: attemptNumber,
            restantes: retriesLeft,
            status: error instanceof APIError ? error.status : undefined,
            error: error.message,
          },
          'fallo la llamada al modelo',
        );
      },
    });
  }
}
