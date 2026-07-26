/**
 * Implementacion de EmbeddingPort contra Voyage AI.
 *
 * Anthropic no ofrece API de embeddings (vacio explicito de la especificacion,
 * ver ESPECIFICACION_TECNICA_CONSTRUCCION.md §1 y docs/decisiones.md). Se
 * eligio Voyage AI, modelo `voyage-3`, 1024 dimensiones porque coincide
 * exactamente con la columna `vector(1024)` de `knowledge_chunks` (migracion
 * 001) y con `match_knowledge` (migracion 003, p_embedding vector(1024)).
 *
 * Se usa `fetch` global (Node 24) contra la API REST, sin SDK: es una unica
 * llamada HTTP y anadir una dependencia para eso no se justifica (regla de
 * "no instales paquetes nuevos" del contrato de construccion).
 *
 * Formato de peticion/respuesta verificado contra la documentacion publica de
 * Voyage (docs.voyageai.com/reference/embeddings-api), NO contra una llamada
 * real (esta rama no tiene VOYAGE_API_KEY): `voyage-3` sigue documentado
 * ("Older models", 1024 dimensiones fijas, coincide con el esquema); el
 * limite es 1000 textos por peticion y el limite de tokens varia por modelo
 * (no se encontro el dato exacto para voyage-3 puntualmente, asi que el lote
 * por defecto se deja conservador); la respuesta tiene la forma
 * `{ data: [{ embedding: number[], index: number }], ... }`. Si el formato
 * real difiere, el error de parseo de Zod lo expondra con claridad en vez de
 * fallar en silencio.
 */
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';
import type { EmbeddingPort } from '../types/index.js';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

/**
 * Limite de textos por peticion. La documentacion publica de Voyage fija 1000
 * como maximo por peticion; se deja un margen conservador (no se verifico el
 * limite de tokens totales por peticion especifico de voyage-3) y
 * configurable por constructor.
 */
const DEFAULT_MAX_TEXTOS_POR_LOTE = 128;

const voyageEmbeddingItemSchema = z.object({
  embedding: z.array(z.number()),
  index: z.number().int().nonnegative(),
});

const voyageResponseSchema = z.object({
  data: z.array(voyageEmbeddingItemSchema),
});

export interface VoyageEmbeddingServiceOptions {
  /** Puede faltar: se valida al usar, no al construir (ver requisito de config opcional). */
  apiKey?: string;
  model?: string;
  dimensions?: number;
  maxTextosPorLote?: number;
  /** Inyectable para pruebas; por defecto el fetch global. */
  fetchFn?: typeof fetch;
  retries?: number;
}

export class VoyageEmbeddingService implements EmbeddingPort {
  readonly dimensions: number;

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly maxTextosPorLote: number;
  private readonly fetchFn: typeof fetch;
  private readonly retries: number;

  constructor(options: VoyageEmbeddingServiceOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'voyage-3';
    this.dimensions = options.dimensions ?? 1024;
    this.maxTextosPorLote = options.maxTextosPorLote ?? DEFAULT_MAX_TEXTOS_POR_LOTE;
    this.fetchFn = options.fetchFn ?? fetch;
    this.retries = options.retries ?? 3;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Falla al usarse, no al construirse: el constructor no exige la clave
    // porque VOYAGE_API_KEY es opcional en config.ts (el sistema puede
    // arrancar sin RAG configurado); pero un intento real de embeber sin
    // clave es un error de configuracion que debe ser explicito.
    if (!this.apiKey) {
      throw new Error(
        'VOYAGE_API_KEY no esta configurada: no se puede generar embeddings. Configure la clave o deshabilite el RAG.',
      );
    }

    const lotes = dividirEnLotes(texts, this.maxTextosPorLote);
    const resultado: number[][] = [];

    for (const lote of lotes) {
      const vectores = await pRetry(() => this.llamarVoyage(lote, kind), {
        retries: this.retries,
        minTimeout: 300,
        factor: 2,
      });
      resultado.push(...vectores);
    }

    return resultado;
  }

  private async llamarVoyage(lote: string[], kind: 'document' | 'query'): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.fetchFn(VOYAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: lote, model: this.model, input_type: kind }),
      });
    } catch (err) {
      // Error de red (fetch rechaza): dejar que p-retry decida si reintenta.
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!response.ok) {
      const cuerpo = await response.text().catch(() => '');
      const mensaje = `Voyage AI respondio ${response.status} ${response.statusText}: ${cuerpo.slice(0, 500)}`;
      // 4xx (salvo 429, limite de tasa) es un error de peticion que no se
      // arregla reintentando: clave invalida, modelo inexistente, etc.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new AbortError(mensaje);
      }
      throw new Error(mensaje);
    }

    const json: unknown = await response.json();
    const parseado = voyageResponseSchema.parse(json);

    const vectores = parseado.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    for (const vector of vectores) {
      if (vector.length !== this.dimensions) {
        // Error irrecuperable de configuracion (modelo/dimension no coinciden
        // con el esquema): no tiene sentido reintentar.
        throw new AbortError(
          `Voyage AI devolvio un vector de ${vector.length} dimensiones; se esperaban ${this.dimensions} (columna vector(${this.dimensions}) del esquema)`,
        );
      }
    }

    return vectores;
  }
}

function dividirEnLotes<T>(items: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    lotes.push(items.slice(i, i + tamano));
  }
  return lotes;
}
