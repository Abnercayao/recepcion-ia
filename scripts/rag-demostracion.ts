/**
 * RAG de demostracion: coincidencia de PALABRAS sobre los documentos de
 * `db/seed/clinica-demo/`, sin embeddings y sin base de datos.
 *
 * Vive aqui, y no dentro de `scripts/demo.ts`, porque lo usan dos herramientas
 * —el demo de terminal y la consola web— y `demo.ts` arranca su `main()` al
 * importarse: no se puede reutilizar nada de el sin lanzar el demo entero.
 *
 * ES PEOR QUE EL RAG REAL, a proposito. Recupera menos y peor, y no conoce el
 * umbral de similitud del coseno. Si el agente dice que no tiene un dato que si
 * esta en la base, sospecha de esto antes que del prompt.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { chunkText } from '../src/core/rag/chunker.js';
import type { KnowledgeChunk, RagPort } from '../src/core/types/index.js';

const RAIZ = resolve(import.meta.dirname, '..');
const DIR_SEMILLA = join(RAIZ, 'db', 'seed', 'clinica-demo');

/** Palabras vacias del espanol: no aportan senal y ensucian el solapamiento. */
const VACIAS = new Set(
  ('a al algo alguna alguno ante antes aqui asi aunque cada como con contra cual cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa ese eso esta estan este esto ha hace hacen hasta hay la las le les lo los mas me mi mucho muy no nos o os otra otro para pero poco por porque que quien se ser si sin sobre solo son su sus tambien tan te tiene tienen todo todos tu un una uno unos y ya').split(
    ' ',
  ),
);

function tokenizar(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !VACIAS.has(t));
}

const FUENTES: Array<[string, KnowledgeChunk['fuente']]> = [
  ['formulario-maestro.md', 'formulario'],
  ['faqs.md', 'faq'],
  ['protocolo-urgencias.md', 'protocolo_urgencia'],
];

export class RagDeDemostracion implements RagPort {
  private constructor(
    private readonly clinicId: string,
    private readonly fragmentos: Array<{ chunk: KnowledgeChunk; tokens: Set<string> }>,
  ) {}

  static async cargar(clinicId: string): Promise<RagDeDemostracion> {
    const fragmentos: Array<{ chunk: KnowledgeChunk; tokens: Set<string> }> = [];

    for (const [archivo, fuente] of FUENTES) {
      const contenido = await readFile(join(DIR_SEMILLA, archivo), 'utf8');
      // Mismo criterio que el cargador real: el FAQ se fragmenta por parrafo
      // para no mezclar preguntas sin relacion en un mismo fragmento.
      const trozos = chunkText(
        { contenido, fuente, version: 1 },
        fuente === 'faq' ? { unParrafoPorFragmento: true } : {},
      );
      for (const [i, trozo] of trozos.entries()) {
        fragmentos.push({
          chunk: { id: `${fuente}-${i}`, clinicId, contenido: trozo.contenido, fuente },
          tokens: new Set(tokenizar(trozo.contenido)),
        });
      }
    }

    return new RagDeDemostracion(clinicId, fragmentos);
  }

  get total(): number {
    return this.fragmentos.length;
  }

  retrieve(clinicId: string, query: string, limit = 5): Promise<KnowledgeChunk[]> {
    // El aislamiento entre clinicas se respeta tambien aqui, aunque el demo
    // tenga una sola: es la invariante mas importante del sistema.
    if (clinicId !== this.clinicId) return Promise.resolve([]);

    const consulta = tokenizar(query);
    if (consulta.length === 0) return Promise.resolve([]);

    const puntuados = this.fragmentos
      .map(({ chunk, tokens }) => {
        const comunes = consulta.filter((t) => tokens.has(t)).length;
        return { chunk, score: comunes / consulta.length };
      })
      .filter((f) => f.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return Promise.resolve(puntuados.map((p) => ({ ...p.chunk, similarity: p.score })));
  }
}
