/**
 * Carga la base de conocimiento de una clinica en `knowledge_chunks`.
 *
 * Flujo: leer los documentos de la fuente -> fragmentar -> embeber -> insertar
 * SIEMPRE con `activo = false`.
 *
 * La activacion es un acto HUMANO deliberado, no un paso del script: el control
 * O2 del informe etico exige aprobacion escrita del profesional responsable
 * antes de que ningun contenido con implicancia clinica llegue a produccion.
 * Por eso `--aprobar-como` es un flag explicito que obliga a nombrar a quien
 * aprueba, y nunca se activa nada por omision.
 *
 * Uso:
 *   npm run db:seed -- --dry-run
 *   npm run db:seed -- --dir db/seed/clinica-demo
 *   npm run db:seed -- --dir db/seed/clinica-demo --aprobar-como "Dra. Carmen Rios"
 */
// Carga `.env` antes que nada: `loadConfig()` y las lecturas directas de
// `process.env` de este archivo ocurren al importar, y sin esto un `.env`
// presente se ignoraria en silencio. `src/server.ts` ya lo hacia; los
// scripts no, y por eso el flujo del README (`cp .env.example .env` y luego
// `npm run db:migrate`) fallaba enumerando variables «ausentes» que si estaban.
import 'dotenv/config';

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { chunkText, type ChunkInput, type ChunkerOptions } from '../src/core/rag/chunker.js';
import { VoyageEmbeddingService } from '../src/core/rag/embedding.service.js';
import { SupabaseKnowledgeRepository } from '../src/core/rag/knowledge.repository.js';
import { loadConfig } from '../src/infra/config.js';
import type { KnowledgeChunk } from '../src/core/types/index.js';

/**
 * Mapeo de nombre de archivo a fuente. La fuente no es decorativa: determina la
 * confiabilidad del fragmento (Tabla 10 del informe) y queda en la fila para
 * poder reconstruir de donde salio una respuesta cuestionada.
 */
const FUENTE_POR_ARCHIVO: Record<string, KnowledgeChunk['fuente']> = {
  'formulario-maestro.md': 'formulario',
  'faqs.md': 'faq',
  'protocolo-urgencias.md': 'protocolo_urgencia',
  'web.md': 'web',
};

/**
 * Opciones de fragmentacion POR FUENTE.
 *
 * El valor por defecto de `minCaracteres` (120) fusiona parrafos cortos con el
 * siguiente para que no queden fragmentos sin contexto propio. Eso es correcto
 * en prosa continua (formulario, protocolo), pero es DANINO en un FAQ: cada
 * par pregunta-respuesta es una idea completa aunque ocupe 90 caracteres, y
 * fusionarlo con la pregunta siguiente mezcla dos temas sin relacion en un solo
 * vector. Medido sobre la clinica de demostracion: con el valor por defecto, 22
 * preguntas colapsaban en 5 fragmentos.
 *
 * §3.1.3.B lo dice explicitamente: "un fragmento demasiado extenso diluye la
 * recuperacion; uno demasiado breve pierde el contexto". En un FAQ el punto de
 * equilibrio esta mas abajo que en prosa.
 */
const OPCIONES_POR_FUENTE: Partial<Record<KnowledgeChunk['fuente'], ChunkerOptions>> = {
  faq: { unParrafoPorFragmento: true },
};

const clinicaJsonSchema = z.object({
  id: z.string().uuid(),
  nombre: z.string().min(1),
  timezone: z.string().min(1),
  retencion_transcripcion_dias: z.number().int().nonnegative(),
  retencion_audio_dias: z.number().int().nonnegative(),
  transfer_whitelist: z.array(z.string()),
  config: z.record(z.string(), z.unknown()),
});

interface Opciones {
  dir: string;
  dryRun: boolean;
  aprobarComo?: string;
}

function parseArgs(argv: string[]): Opciones {
  const dryRun = argv.includes('--dry-run');
  const dirIdx = argv.indexOf('--dir');
  const aprobarIdx = argv.indexOf('--aprobar-como');

  const dir = dirIdx >= 0 && argv[dirIdx + 1] ? argv[dirIdx + 1]! : 'db/seed/clinica-demo';
  const aprobarComo = aprobarIdx >= 0 ? argv[aprobarIdx + 1] : undefined;

  if (aprobarIdx >= 0 && (!aprobarComo || aprobarComo.startsWith('--'))) {
    throw new Error(
      '--aprobar-como requiere el nombre de la persona que aprueba. La aprobacion se registra nominalmente (control O2).',
    );
  }

  return { dir, dryRun, ...(aprobarComo ? { aprobarComo } : {}) };
}

async function main(): Promise<void> {
  const opciones = parseArgs(process.argv.slice(2));
  const dirAbs = resolve(process.cwd(), opciones.dir);

  // 1. Leer y fragmentar. Esto no necesita red: es lo unico que corre en dry-run.
  const archivos = await readdir(dirAbs);
  const entradas: ChunkInput[] = [];

  for (const archivo of archivos) {
    const fuente = FUENTE_POR_ARCHIVO[basename(archivo)];
    if (!fuente) continue; // clinica.json y cualquier otra cosa se ignoran aqui

    const contenido = await readFile(join(dirAbs, archivo), 'utf8');
    entradas.push({ contenido, fuente, version: 1 });
  }

  if (entradas.length === 0) {
    throw new Error(
      `No se encontro ningun documento reconocible en ${dirAbs}. Esperados: ${Object.keys(FUENTE_POR_ARCHIVO).join(', ')}`,
    );
  }

  const fragmentos = entradas.flatMap((entrada) =>
    chunkText(entrada, OPCIONES_POR_FUENTE[entrada.fuente] ?? {}),
  );

  console.log(`Documentos leidos: ${entradas.length}`);
  console.log(`Fragmentos generados: ${fragmentos.length}`);
  for (const fuente of new Set(fragmentos.map((f) => f.fuente))) {
    const n = fragmentos.filter((f) => f.fuente === fuente).length;
    console.log(`  ${fuente}: ${n}`);
  }

  if (opciones.dryRun) {
    console.log('\n--dry-run: no se embebe ni se escribe nada.');
    const masLargo = fragmentos.reduce((a, b) => (a.contenido.length >= b.contenido.length ? a : b));
    console.log(`Fragmento mas largo: ${masLargo.contenido.length} caracteres (${masLargo.fuente}).`);
    return;
  }

  // 2. A partir de aqui SI hace falta credencial. Si falta, se falla ahora y
  //    entero, no a mitad de la carga dejando la base incoherente.
  const config = loadConfig();

  if (!config.VOYAGE_API_KEY) {
    throw new Error(
      'Falta VOYAGE_API_KEY. Sin embeddings no se puede poblar knowledge_chunks. Usa --dry-run para validar solo la fragmentacion.',
    );
  }

  const clinica = clinicaJsonSchema.parse(
    JSON.parse(await readFile(join(dirAbs, 'clinica.json'), 'utf8')),
  );

  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

  // 3. Alta de la clinica.
  const { error: errorClinica } = await supabase.from('clinics').upsert(
    {
      id: clinica.id,
      nombre: clinica.nombre,
      timezone: clinica.timezone,
      config: clinica.config,
      retencion_transcripcion_dias: clinica.retencion_transcripcion_dias,
      retencion_audio_dias: clinica.retencion_audio_dias,
      transfer_whitelist: clinica.transfer_whitelist,
    },
    { onConflict: 'id' },
  );

  if (errorClinica) {
    throw new Error(`No se pudo dar de alta la clinica: ${errorClinica.message}`);
  }
  console.log(`\nClinica registrada: ${clinica.nombre} (${clinica.id})`);

  // 4. Embeber. `document` y no `query`: usar el tipo equivocado degrada la
  //    recuperacion de forma silenciosa.
  const embedder = new VoyageEmbeddingService({
    apiKey: config.VOYAGE_API_KEY,
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
  });

  const vectores = await embedder.embed(
    fragmentos.map((f) => f.contenido),
    'document',
  );

  if (vectores.length !== fragmentos.length) {
    throw new Error(
      `El proveedor devolvio ${vectores.length} vectores para ${fragmentos.length} fragmentos.`,
    );
  }

  // 5. Insertar, siempre inactivos.
  const repo = new SupabaseKnowledgeRepository(supabase);
  const ids: string[] = [];

  for (let i = 0; i < fragmentos.length; i++) {
    const fragmento = fragmentos[i]!;
    const embedding = vectores[i]!;
    const { id } = await repo.insertPendiente({
      clinicId: clinica.id,
      contenido: fragmento.contenido,
      embedding,
      fuente: fragmento.fuente,
      version: fragmento.version,
    });
    ids.push(id);
  }

  console.log(`Fragmentos insertados: ${ids.length} (todos con activo = false).`);

  // 6. Aprobacion, solo si se pidio nominalmente.
  if (!opciones.aprobarComo) {
    console.log(
      '\nNinguno esta activo todavia. Ningun fragmento se recuperara hasta que se apruebe.\n' +
        'Para activarlos: npm run db:seed -- --aprobar-como "Nombre del profesional responsable"',
    );
    return;
  }

  for (const id of ids) {
    await repo.aprobar(id, opciones.aprobarComo);
  }

  console.log(`\nFragmentos activados: ${ids.length}, aprobados por "${opciones.aprobarComo}".`);
  console.log(
    'RECORDATORIO: si estos son los datos de demostracion, la aprobacion es ficticia y NO\n' +
      'sustituye la aprobacion escrita de un profesional sanitario real (control O2).',
  );
}

main().catch((error: unknown) => {
  console.error(`\nseed fallo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
