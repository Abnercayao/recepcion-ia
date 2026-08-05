/**
 * Sube la base de conocimiento a ElevenLabs y activa el RAG nativo.
 *
 * Sustituye, para el canal de VOZ, a `knowledge_chunks` (Supabase pgvector) +
 * `VoyageEmbeddingService`. Es el paso que elimina Voyage del camino de la
 * llamada: el proveedor indexa y recupera con su propio modelo.
 *
 * QUE NO SUSTITUYE: el RAG del NUCLEO (`RagService`) sigue siendo el del canal
 * de texto y del modo Custom LLM. Son dos indices distintos sobre los mismos
 * documentos, y hay que reindexar los dos cuando el contenido cambie.
 *
 * ⚠ CONTROL O2. Estos documentos NO estan aprobados por un profesional
 * sanitario. Subirlos aqui no los aprueba: solo los pone a mano del agente.
 *
 * Uso:
 *   npm run agente:rag            # sube y enlaza
 *   npm run agente:rag -- --ver   # lista lo que hay
 */
import 'dotenv/config';

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const RAIZ = resolve(import.meta.dirname, '..');
const DIR = join(RAIZ, 'db', 'seed', 'clinica-demo');
const AGENTE = process.env['ELEVENLABS_AGENT_ID'];
const KEY = process.env['ELEVENLABS_API_KEY'];

/** Los `.md` de la semilla. `clinica.json` no: es configuracion, no conocimiento. */
const EXTENSION = '.md';

async function api(metodo: string, ruta: string, cuerpo?: unknown): Promise<Record<string, any>> {
  const r = await fetch(`https://api.elevenlabs.io${ruta}`, {
    method: metodo,
    headers: { 'xi-api-key': KEY!, 'content-type': 'application/json' },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${t.slice(0, 400)}`);
  return t ? (JSON.parse(t) as Record<string, any>) : {};
}

async function listar(): Promise<Array<{ id: string; name: string }>> {
  const r = await api('GET', '/v1/convai/knowledge-base?page_size=100');
  return ((r['documents'] ?? []) as Array<Record<string, any>>).map((d) => ({
    id: String(d['id']),
    name: String(d['name']),
  }));
}

async function main(): Promise<void> {
  if (!AGENTE || !KEY) throw new Error('Faltan ELEVENLABS_AGENT_ID o ELEVENLABS_API_KEY.');

  if (process.argv.includes('--ver')) {
    const docs = await listar();
    console.log(`documentos en la base: ${docs.length}`);
    for (const d of docs) console.log(`  ${d.id}  ${d.name}`);
    const a = await api('GET', `/v1/convai/agents/${AGENTE}`);
    const p = a['conversation_config']['agent']['prompt'];
    console.log(`\nrag.enabled     : ${p['rag']?.['enabled']}`);
    console.log(`modelo embedding: ${p['rag']?.['embedding_model']}`);
    console.log(`enlazados       : ${(p['knowledge_base'] ?? []).length}`);
    return;
  }

  const archivos = (await readdir(DIR)).filter((f) => f.endsWith(EXTENSION)).sort();
  if (archivos.length === 0) throw new Error(`No hay ${EXTENSION} en ${DIR}`);

  const yaEstan = await listar();
  const enlaces: Array<{ type: string; id: string; name: string; usage_mode: string }> = [];

  for (const archivo of archivos) {
    const nombre = archivo.replace(EXTENSION, '');
    const texto = await readFile(join(DIR, archivo), 'utf8');

    // Se borra el homonimo antes de subir: crear sin borrar deja dos versiones
    // del mismo documento indexadas y el agente recupera la vieja.
    for (const d of yaEstan.filter((x) => x.name === nombre)) {
      await api('DELETE', `/v1/convai/knowledge-base/${d.id}?force=true`).catch(() => ({}));
      console.log(`  (sustituye la version anterior de ${nombre})`);
    }

    const creado = await api('POST', '/v1/convai/knowledge-base/text', { name: nombre, text: texto });
    const id = String(creado['id']);
    console.log(`subido: ${nombre}  ${texto.length} caracteres  id=${id}`);

    // `auto`: el proveedor decide entre meterlo entero en el prompt o
    // recuperarlo por RAG segun su tamano. Los documentos grandes --el de
    // sedes y profesionales pasa de 30 KB-- irian por RAG de todos modos.
    enlaces.push({ type: 'text', id, name: nombre, usage_mode: 'auto' });
  }

  await api('PATCH', `/v1/convai/agents/${AGENTE}`, {
    conversation_config: {
      agent: {
        prompt: {
          knowledge_base: enlaces,
          rag: { enabled: true },
        },
      },
    },
  });

  const a = await api('GET', `/v1/convai/agents/${AGENTE}`);
  const p = a['conversation_config']['agent']['prompt'];
  console.log(`\nrag.enabled : ${p['rag']?.['enabled']}`);
  console.log(`enlazados   : ${(p['knowledge_base'] ?? []).map((k: any) => k.name).join(', ')}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
