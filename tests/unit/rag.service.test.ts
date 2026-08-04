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

/** Doble de KnowledgeRepository: RagService usa matchKnowledge y buscarPorPalabras. */
class FakeKnowledgeRepository implements KnowledgeRepository {
  readonly calls: Array<{ clinicId: string; embedding: number[]; limit: number; minSimilarity: number }> = [];
  /** Llamadas al respaldo lexico, para poder afirmar CUANDO se recurre a el. */
  readonly llamadasLexicas: Array<{ clinicId: string; query: string; limit: number }> = [];

  constructor(
    private readonly impl: (
      clinicId: string,
      embedding: number[],
      limit: number,
      minSimilarity: number,
    ) => Promise<KnowledgeChunk[]>,
    /** Por defecto el lexico no devuelve nada: preserva el comportamiento que esperan los tests previos. */
    private readonly implLexica: (
      clinicId: string,
      query: string,
      limit: number,
    ) => Promise<KnowledgeChunk[]> = async () => [],
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

  async buscarPorPalabras(
    clinicId: string,
    query: string,
    limit: number,
  ): Promise<KnowledgeChunk[]> {
    this.llamadasLexicas.push({ clinicId, query, limit });
    return this.implLexica(clinicId, query, limit);
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
  it('usa los valores por defecto: 5 fragmentos y umbral de similitud 0.45', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    await service.retrieve(CLINIC_A, 'consulta cualquiera');

    expect(repo.calls[0]).toMatchObject({ limit: 5, minSimilarity: 0.45 });
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

  it('si el embedding falla (p. ej. Voyage limitando), cae al respaldo lexico', async () => {
    const chunk: KnowledgeChunk = {
      id: 'k1',
      clinicId: CLINIC_A,
      contenido: 'Hay 24 sedes en Lima.',
      fuente: 'faq',
    };
    const embeddings = new FakeEmbeddingPort(async () => {
      throw new Error('Voyage AI respondio 429 Too Many Requests');
    });
    const repo = new FakeKnowledgeRepository(
      async () => [],
      async () => [chunk],
    );
    const logger = new FakeLogger();
    const service = new RagService(embeddings, repo, logger);

    const resultado = await service.retrieve(CLINIC_A, 'cuantas sedes tienen');

    // Lo que importa: NO se queda sin contexto. Sin fragmentos el modelo
    // rellena, y esa linea roja no tiene control automatico en capa 2.
    expect(resultado).toEqual([chunk]);
    expect(repo.llamadasLexicas).toHaveLength(1);
    expect(repo.llamadasLexicas[0]).toMatchObject({ clinicId: CLINIC_A });
    // El fallo vectorial es un aviso, no el final del camino.
    expect(logger.errores).toHaveLength(0);
  });

  it('si el vectorial no supera el umbral, tambien intenta el lexico antes de rendirse', async () => {
    const chunk: KnowledgeChunk = {
      id: 'k2',
      clinicId: CLINIC_A,
      contenido: 'Los sabados se atiende de 9:00 a 13:00.',
      fuente: 'faq',
    };
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(
      async () => [],
      async () => [chunk],
    );
    const service = new RagService(embeddings, repo, new FakeLogger());

    expect(await service.retrieve(CLINIC_A, 'horario sabado')).toEqual([chunk]);
    expect(repo.llamadasLexicas).toHaveLength(1);
  });

  it('el respaldo lexico recibe el clinicId del llamador (aislamiento C9)', async () => {
    const otraClinica = '11111111-1111-4111-8111-111111111111';
    const embeddings = new FakeEmbeddingPort(async () => {
      throw new Error('429');
    });
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    await service.retrieve(otraClinica, 'consulta');

    expect(repo.llamadasLexicas[0]?.clinicId).toBe(otraClinica);
  });

  it('omite la recuperacion en mensajes de pura cortesia (un saludo no necesita contexto)', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    for (const saludo of ['Hola', 'buenas tardes', 'Gracias', 'hasta luego']) {
      expect(await service.retrieve(CLINIC_A, saludo)).toEqual([]);
    }

    // Ni una llamada a Voyage ni a la base: es todo el objetivo del atajo.
    expect(embeddings.calls).toHaveLength(0);
    expect(repo.calls).toHaveLength(0);
    expect(repo.llamadasLexicas).toHaveLength(0);
  });

  it('NO omite la recuperacion si el saludo trae ademas una pregunta', async () => {
    const embeddings = new FakeEmbeddingPort(async () => [[0, 0, 0]]);
    const repo = new FakeKnowledgeRepository(async () => []);
    const service = new RagService(embeddings, repo, new FakeLogger());

    // El sesgo esta en no saltar: cualquier cosa mas que la cortesia, recupera.
    for (const texto of ['Hola, ¿trabajan con EPS?', 'gracias, y el horario del sabado?']) {
      await service.retrieve(CLINIC_A, texto);
    }

    expect(embeddings.calls).toHaveLength(2);
  });

  it('fail-safe: si fallan las DOS vias, devuelve lista vacia y registra el error', async () => {
    const embeddings = new FakeEmbeddingPort(async () => {
      throw new Error('VOYAGE_API_KEY no esta configurada');
    });
    const repo = new FakeKnowledgeRepository(
      async () => [],
      async () => {
        throw new Error('conexion rechazada');
      },
    );
    const logger = new FakeLogger();
    const service = new RagService(embeddings, repo, logger);

    const resultado = await service.retrieve(CLINIC_A, 'consulta');

    expect(resultado).toEqual([]);
    expect(logger.errores).toHaveLength(1);
    expect(logger.errores[0]?.obj).toMatchObject({ clinicId: CLINIC_A });
  });
});
