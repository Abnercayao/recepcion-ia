import { describe, expect, it } from 'vitest';
import type { EmbeddingPort, KnowledgeChunk, Logger } from '../../src/core/types/index.js';
import type { KnowledgeRepository, NuevoChunk } from '../../src/core/rag/knowledge.repository.js';
import { RagService } from '../../src/core/rag/rag.service.js';

/** Doble de EmbeddingPort: registra las llamadas y delega en una funcion de prueba. */
class FakeEmbeddingPort implements EmbeddingPort {
  readonly dimensions = 3;
  readonly calls: Array<{ texts: string[]; kind: 'document' | 'query' }> = [];

  constructor(
    private readonly impl: (texts: string[], kind: 'document' | 'query') => Promise<number[][]>,
  ) {}

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    this.calls.push({ texts, kind });
    return this.impl(texts, kind);
  }
}

/** Doble de KnowledgeRepository: solo matchKnowledge se ejercita desde RagService. */
class FakeKnowledgeRepository implements KnowledgeRepository {
  readonly calls: Array<{ clinicId: string; embedding: number[]; limit: number; minSimilarity: number }> = [];

  constructor(
    private readonly impl: (
      clinicId: string,
      embedding: number[],
      limit: number,
      minSimilarity: number,
    ) => Promise<KnowledgeChunk[]>,
  ) {}

  async matchKnowledge(
    clinicId: string,
    embedding: number[],
    limit: number,
    minSimilarity: number,
  ): Promise<KnowledgeChunk[]> {
    this.calls.push({ clinicId, embedding, limit, minSimilarity });
    return this.impl(clinicId, embedding, limit, minSimilarity);
  }

  async insertPendiente(_chunk: NuevoChunk): Promise<{ id: string }> {
    throw new Error('no usado por RagService');
  }

  async aprobar(_chunkId: string, _aprobadoPor: string): Promise<void> {
    throw new Error('no usado por RagService');
  }
}

/** Doble minimo de Logger: registra los errores para poder aseverar el fail-safe. */
class FakeLogger implements Logger {
  readonly errores: Array<{ obj: Record<string, unknown>; msg?: string }> = [];

  fatal(): void {}
  error(obj: Record<string, unknown>, msg?: string): void {
    this.errores.push({ obj, msg });
  }
  warn(): void {}
  info(): void {}
  debug(): void {}
  child(): Logger {
    return this;
  }
}

const CLINIC_A = '11111111-1111-1111-1111-111111111111';

function fragmento(parcial: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    id: 'chunk-1',
    clinicId: CLINIC_A,
    contenido: 'Atendemos de lunes a viernes de 9 a 18.',
    fuente: 'faq',
    similarity: 0.9,
    ...parcial,
  };
}

describe('RagService.retrieve', () => {
  it('embebe la consulta como "query" (no "document") y pasa el vector al repositorio', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0.1, 0.2, 0.3]]);
    const esperado = [fragmento()];
    const repo = new FakeKnowledgeRepository(async () => esperado);
    const logger = new FakeLogger();

    const service = new RagService(embeddings, repo, logger);
    const resultado = await service.retrieve(CLINIC_A, 'a que hora abren?');

    expect(embeddings.calls).toEqual([{ texts: ['a que hora abren?'], kind: 'query' }]);
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(resultado).toBe(esperado);
  });

  // El umbral fue 0.75 hasta que se midio contra la base real: el fragmento
  // CORRECTO puntuaba entre 0.41 y 0.71 con voyage-3, asi que no pasaba nada y
  // el RAG devolvia lista vacia siempre. El modo de fallo no era el silencio
  // prudente que se buscaba, sino el modelo rellenando el hueco. Ver la
  // cabecera de rag.service.ts.
  it('usa los valores por defecto: 5 fragmentos y umbral de similitud 0.35', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    await service.retrieve(CLINIC_A, 'consulta cualquiera');

    expect(repo.calls[0]).toMatchObject({ limit: 5, minSimilarity: 0.35 });
  });

  it('permite sobreescribir el limite de fragmentos por llamada', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    await service.retrieve(CLINIC_A, 'consulta', 2);

    expect(repo.calls[0]?.limit).toBe(2);
  });

  it('permite configurar el umbral y el limite por defecto en el constructor', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger(), {
      umbralSimilitud: 0.9,
      limiteFragmentos: 3,
    });

    await service.retrieve(CLINIC_A, 'consulta');

    expect(repo.calls[0]).toMatchObject({ limit: 3, minSimilarity: 0.9 });
  });

  it('pasa siempre el clinicId recibido, sin alterarlo (aislamiento entre clinicas, control C9)', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    const otraClinica = '22222222-2222-2222-2222-222222222222';
    await service.retrieve(otraClinica, 'consulta');

    expect(repo.calls[0]?.clinicId).toBe(otraClinica);
  });

  it('devuelve lista vacia cuando no hay fragmentos por encima del umbral (v0.4: declarar ausencia, no inventar)', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    const resultado = await service.retrieve(CLINIC_A, 'pregunta muy rara sin relacion con la base');

    expect(resultado).toEqual([]);
  });

  it('devuelve lista vacia sin llamar a embeddings ni al repositorio cuando la consulta esta vacia', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    const resultado = await service.retrieve(CLINIC_A, '   ');

    expect(resultado).toEqual([]);
    expect(embeddings.calls).toHaveLength(0);
    expect(repo.calls).toHaveLength(0);
  });

  it('fail-safe: si el embedding falla (p. ej. Voyage caido), devuelve lista vacia y registra el error', async () => {
    const embeddings = new FakeEmbeddingPort(async () => {
      throw new Error('VOYAGE_API_KEY no esta configurada');
    });
    const repo = new FakeKnowledgeRepository(async () => []);
    const logger = new FakeLogger();
    const service = new RagService(embeddings, repo, logger);

    const resultado = await service.retrieve(CLINIC_A, 'consulta');

    expect(resultado).toEqual([]);
    expect(logger.errores).toHaveLength(1);
    expect(logger.errores[0]?.obj).toMatchObject({ clinicId: CLINIC_A });
  });

  it('fail-safe: si el repositorio falla (p. ej. Supabase caido), devuelve lista vacia y registra el error', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => {
      throw new Error('conexion rechazada');
    });
    const logger = new FakeLogger();
    const service = new RagService(embeddings, repo, logger);

    const resultado = await service.retrieve(CLINIC_A, 'consulta');

    expect(resultado).toEqual([]);
    expect(logger.errores).toHaveLength(1);
  });
});
