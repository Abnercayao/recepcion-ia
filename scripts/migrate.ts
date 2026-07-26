/**
 * migrate.ts
 *
 * Aplica en orden los archivos SQL de db/migrations/ contra la base de datos
 * de Supabase. Idempotente: cada migracion se registra en una tabla de
 * control (`public._migrations`) por nombre de archivo + checksum, y una
 * migracion ya aplicada con el mismo contenido se omite en la siguiente
 * corrida.
 *
 * =============================================================================
 * VACIO REAL DETECTADO EN LA ESPECIFICACION -- LEER ANTES DE USAR ESTE SCRIPT
 * =============================================================================
 * El encargo pide "aplica las migraciones ... leyendo la config de
 * src/infra/config.js (usa loadConfig)". loadConfig() valida SUPABASE_URL y
 * SUPABASE_SERVICE_KEY (seccion 14 de la especificacion), pero esas dos
 * variables NO ALCANZAN para ejecutar SQL de migracion:
 *
 *   - SUPABASE_SERVICE_KEY es un JWT que autentica contra la API REST/Auth de
 *     Supabase (PostgREST), no una credencial de Postgres.
 *   - @supabase/supabase-js (el cliente que fabrica
 *     src/infra/supabase.client.ts) habla con PostgREST, que POR DISENO no
 *     expone un endpoint de "ejecutar SQL arbitrario": solo puede hacer
 *     select/insert/update/delete sobre tablas/vistas ya existentes o llamar
 *     RPCs ya definidas. No hay forma de mandarle un "create table" ni un
 *     "create policy" a traves de ese cliente.
 *
 * Por eso este script NO reutiliza src/infra/supabase.client.ts (lo cual
 * podria parecer la opcion obvia): ese cliente sirve para el trafico normal
 * de la aplicacion, no para migrar el esquema.
 *
 * Ejecutar SQL de migracion requiere una conexion Postgres directa (el
 * connection string de "Project Settings > Database > Connection string" en
 * el panel de Supabase, con la contrasena de la base, NO la service key). La
 * especificacion (seccion 14) no incluye ninguna variable de entorno para
 * esto. Este script la exige por separado, como SUPABASE_DB_URL, y falla con
 * un mensaje explicito si falta -- ver explainMissingDbUrl() mas abajo.
 *
 * Ademas, ejecutar esa conexion requiere un driver de Postgres (el paquete
 * npm "pg"), que HOY NO ESTA INSTALADO en este proyecto (verificado: no esta
 * en package.json ni en node_modules) y esta rama tiene prohibido instalar
 * paquetes nuevos (contrato de construccion). El script detecta esto en
 * tiempo de ejecucion e informa exactamente que falta, en vez de fallar a
 * medias o simular que funciono.
 *
 * EN ESTA CONSTRUCCION NO SE PUDO EJECUTAR ESTE SCRIPT NI UNA SOLA VEZ: no
 * hay credenciales de Supabase disponibles. No se intento correrlo contra una
 * base real. Ver el informe final de esta rama.
 * =============================================================================
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from '../src/infra/config.js';
import { createLogger } from '../src/infra/logger.js';
import type { Logger } from '../src/core/types/index.js';

/**
 * Superficie minima del paquete "pg", que HOY NO esta instalado (verificado:
 * no figura en package.json ni en node_modules). No se puede escribir
 * `import type { Client } from 'pg'` ni `declare module 'pg' { ... }`
 * (intentado primero): con `verbatimModuleSyntax`/NodeNext, TypeScript trata
 * un `declare module` de nombre externo dentro de un archivo con imports
 * como una AUMENTACION de ese modulo, y falla con "Invalid module name in
 * augmentation, module 'pg' cannot be found" porque no hay nada que aumentar.
 *
 * Por eso el tipo se declara aqui como una interfaz propia (PgModuleLike) y
 * el import se hace por VARIABLE, no por literal (ver PG_MODULE_SPECIFIER):
 * un `import()` dinamico cuyo argumento no es un literal de cadena no se
 * resuelve en tiempo de compilacion, asi que TypeScript no intenta buscar
 * los tipos de 'pg' y no hay error TS2307/TS2664. El resultado se recibe
 * como `unknown` y se estrecha manualmente a PgModuleLike -exactamente el
 * patron "sin any, usa unknown y estrecha" que pide el contrato de
 * construccion-. En tiempo de EJECUCION sigue siendo un import real: si el
 * paquete no esta instalado, Node lanza ERR_MODULE_NOT_FOUND y
 * connectExecutor lo convierte en un mensaje claro.
 */
interface PgClientLike {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
interface PgModuleLike {
  Client: new (config: { connectionString: string }) => PgClientLike;
}
/** Sin anotacion de tipo string, esta constante seria un literal 'pg' y TS
 * intentaria resolverla igual que un import estatico. Anotada como `string`
 * ancho, deja de ser un literal para el analisis de modulos. */
const PG_MODULE_SPECIFIER: string = 'pg';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(SCRIPT_DIR, '..', 'db', 'migrations');
const TRACKING_TABLE = 'public._migrations';

interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedRecord {
  filename: string;
  checksum: string;
}

/** Lee y ordena los .sql de db/migrations. El orden alfabetico == orden numerico (001, 002, 003...). */
function readMigrationFiles(dir: string): MigrationFile[] {
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return filenames.map((filename) => {
    const sql = readFileSync(path.join(dir, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { filename, sql, checksum };
  });
}

/**
 * Decide que migraciones faltan por aplicar. Funcion pura (sin I/O): facil de
 * razonar y de auditar sin necesitar una conexion real a la base.
 *
 * Si un archivo ya aplicado cambio de contenido (checksum distinto al
 * registrado), NO se reaplica en silencio: se lanza un error. Una migracion
 * ya aplicada es historia; si el archivo cambio despues, hace falta una
 * migracion nueva, no editar la vieja.
 */
export function planPending(files: MigrationFile[], applied: AppliedRecord[]): MigrationFile[] {
  const appliedChecksumByName = new Map(applied.map((a) => [a.filename, a.checksum]));
  const pending: MigrationFile[] = [];

  for (const file of files) {
    const previousChecksum = appliedChecksumByName.get(file.filename);
    if (previousChecksum === undefined) {
      pending.push(file);
      continue;
    }
    if (previousChecksum !== file.checksum) {
      throw new Error(
        `La migracion "${file.filename}" ya fue aplicada con OTRO contenido ` +
          `(checksum registrado: ${previousChecksum.slice(0, 12)}..., checksum actual: ` +
          `${file.checksum.slice(0, 12)}...). No se reaplica automaticamente. ` +
          `Crea una migracion nueva con el cambio en vez de editar una ya aplicada.`,
      );
    }
    // Mismo checksum: ya aplicada tal cual. Se omite (idempotencia).
  }
  return pending;
}

interface SqlExecutor {
  query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

/** Mensaje de error cuando falta el connection string directo a Postgres. */
function explainMissingDbUrl(): string {
  return (
    'Config invalida para migrar. No se aplico nada.\n' +
    '  - SUPABASE_DB_URL: requerida y ausente.\n' +
    '    SUPABASE_URL y SUPABASE_SERVICE_KEY (las que valida loadConfig()) autentican ' +
    'contra la API REST/Auth de Supabase (PostgREST), NO contra Postgres directamente: ' +
    'no sirven para ejecutar "create table", "create policy" ni "revoke".\n' +
    '    Se necesita el connection string de Postgres: panel de Supabase > Project ' +
    'Settings > Database > Connection string (URI), forma ' +
    'postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres. ' +
    'Esa contrasena es distinta de SUPABASE_SERVICE_KEY.\n' +
    '  Este vacio de variables no esta en la seccion 14 de la especificacion: se reporta ' +
    'en el informe final de la rama A (capa de datos).'
  );
}

/** Mensaje de error cuando no hay forma de ejecutar SQL (falta el driver 'pg'). */
function explainMissingDriver(cause: unknown): string {
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  return (
    'No se pudo cargar el paquete "pg" (no esta instalado en este proyecto: no figura en ' +
    'package.json ni en node_modules). Aplicar SQL de migracion requiere una conexion ' +
    'directa a Postgres; @supabase/supabase-js no sirve para esto (ver cabecera del archivo). ' +
    'Por regla del contrato de construccion, esta rama no instala paquetes nuevos: se ' +
    'reporta aqui en vez de instalarlo. Para desbloquear: agregar la dependencia "pg" a ' +
    'package.json (y @types/pg si se prefiere no depender de esta declaracion ambiental), o ' +
    'aplicar estas migraciones con `supabase db push` / `psql` usando el mismo connection ' +
    `string. Error original: ${causeMsg}`
  );
}

/**
 * Abre una conexion directa a Postgres usando el paquete 'pg', importado en
 * tiempo de ejecucion (no como dependencia estatica: ver el comentario sobre
 * PgModuleLike/PG_MODULE_SPECIFIER arriba). Si el paquete no esta instalado,
 * falla con un mensaje que explica exactamente por que y como desbloquearlo.
 */
async function connectExecutor(dbUrl: string): Promise<SqlExecutor> {
  let pgModule: PgModuleLike;
  try {
    const imported: unknown = await import(PG_MODULE_SPECIFIER);
    pgModule = imported as PgModuleLike;
  } catch (cause) {
    throw new Error(explainMissingDriver(cause));
  }

  const client = new pgModule.Client({ connectionString: dbUrl });
  await client.connect();

  return {
    async query(sql: string, values?: unknown[]) {
      const result = await client.query(sql, values);
      return result.rows;
    },
    async close() {
      await client.end();
    },
  };
}

async function ensureTrackingTable(executor: SqlExecutor): Promise<void> {
  await executor.query(`
    create table if not exists ${TRACKING_TABLE} (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

async function fetchApplied(executor: SqlExecutor): Promise<AppliedRecord[]> {
  const rows = await executor.query(`select filename, checksum from ${TRACKING_TABLE} order by filename;`);
  return rows.map((row) => ({
    filename: String(row['filename']),
    checksum: String(row['checksum']),
  }));
}

/**
 * Aplica un archivo dentro de una transaccion propia: si falla a mitad, hace
 * rollback completo. Nunca deja un archivo "a medio aplicar" ni sigue con el
 * siguiente archivo tras un fallo (ver loop en main()).
 */
async function applyMigration(executor: SqlExecutor, file: MigrationFile, logger: Logger): Promise<void> {
  await executor.query('begin;');
  try {
    await executor.query(file.sql);
    await executor.query(`insert into ${TRACKING_TABLE} (filename, checksum) values ($1, $2);`, [
      file.filename,
      file.checksum,
    ]);
    await executor.query('commit;');
    logger.info({ filename: file.filename, checksum: file.checksum.slice(0, 12) }, 'migracion aplicada');
  } catch (err) {
    await executor.query('rollback;');
    throw err;
  }
}

async function main(): Promise<void> {
  // Paso 1: config general de la aplicacion. Si falta algo (ANTHROPIC_API_KEY,
  // SUPABASE_URL, etc.), loadConfig() lanza ConfigError con el detalle exacto.
  // No se sigue a medias: se corta aqui mismo.
  const config = loadConfig();
  const logger = createLogger(config);

  // Paso 2: la variable que la especificacion NO documenta (ver cabecera).
  const dbUrl = process.env['SUPABASE_DB_URL'];
  if (!dbUrl) {
    throw new Error(explainMissingDbUrl());
  }

  const files = readMigrationFiles(MIGRATIONS_DIR);
  if (files.length === 0) {
    throw new Error(`No se encontraron archivos .sql en ${MIGRATIONS_DIR}.`);
  }

  logger.info({ archivos: files.map((f) => f.filename) }, 'migraciones encontradas, conectando a Postgres');

  const executor = await connectExecutor(dbUrl);
  try {
    await ensureTrackingTable(executor);
    const applied = await fetchApplied(executor);
    const pending = planPending(files, applied);

    if (pending.length === 0) {
      logger.info({}, 'nada que aplicar: todas las migraciones ya estan registradas');
      return;
    }

    for (const file of pending) {
      await applyMigration(executor, file, logger);
    }

    logger.info({ aplicadas: pending.length }, 'migraciones aplicadas correctamente');
  } finally {
    await executor.close();
  }
}

main().catch((err: unknown) => {
  // No se usa el logger aqui a proposito: si el fallo ocurrio ANTES de poder
  // construir el logger (p. ej. ConfigError, que se lanza dentro de
  // loadConfig antes de createLogger), no habria logger que usar. console.error
  // llega siempre, sin depender de que la config haya sido valida.
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else if (err instanceof Error) {
    console.error(`Fallo la migracion. No se aplico nada mas.\n${err.message}`);
  } else {
    console.error('Fallo la migracion por un error no reconocido:', err);
  }
  process.exitCode = 1;
});
