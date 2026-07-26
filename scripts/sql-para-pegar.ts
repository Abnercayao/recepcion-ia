/**
 * Genera UN solo archivo SQL con todas las migraciones pendientes, listo para
 * pegar en el editor SQL del panel de Supabase.
 *
 * POR QUE EXISTE
 * `npm run db:migrate` necesita `SUPABASE_DB_URL`, es decir conexion directa a
 * Postgres por el puerto 5432. Eso no siempre esta disponible: el host directo
 * `db.<proyecto>.supabase.co` ya no se provisiona en los proyectos nuevos, hay
 * redes que no dejan salir por ese puerto, y desde un movil sencillamente no
 * hay terminal. El editor SQL del panel es HTTP y funciona en cualquier sitio.
 *
 * EL REGISTRO QUEDA COHERENTE. El archivo incluye la tabla de control
 * `public._migrations` y las filas con el checksum sha256 exacto de cada
 * archivo, los mismos que calcula `migrate.ts`. Asi, cuando la conexion
 * directa vuelva a funcionar, `npm run db:migrate` vera las migraciones como
 * ya aplicadas y no intentara reaplicarlas.
 *
 *   npm run db:sql              # escribe migraciones.sql en la raiz
 *   npm run db:sql -- --salida /ruta/archivo.sql
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORIO = join(RAIZ, 'db', 'migrations');
const TABLA_DE_CONTROL = 'public._migrations';

/** Escapa una cadena para un literal SQL. Los checksums y nombres de archivo
 *  son hexadecimales y rutas, pero duplicar la comilla cuesta nada. */
const literal = (texto: string): string => `'${texto.replace(/'/g, "''")}'`;

function main(): void {
  const argumentos = process.argv.slice(2);
  const indiceSalida = argumentos.indexOf('--salida');
  const destino = indiceSalida >= 0 && argumentos[indiceSalida + 1]
    ? (argumentos[indiceSalida + 1] as string)
    : join(RAIZ, 'migraciones.sql');

  const archivos = readdirSync(DIRECTORIO).filter((f) => f.endsWith('.sql')).sort();
  if (archivos.length === 0) throw new Error(`no hay migraciones en ${DIRECTORIO}`);

  const partes: string[] = [
    '-- ============================================================',
    '-- Recepcion-IA · migraciones para pegar en el editor SQL',
    '--',
    '-- Generado por scripts/sql-para-pegar.ts. NO editar a mano: si cambias',
    '-- algo aqui, el checksum dejara de cuadrar con el archivo del repositorio',
    '-- y `npm run db:migrate` lo denunciara como migracion alterada.',
    '--',
    '-- Ejecutalo ENTERO y de una vez. Va dentro de una transaccion: si algo',
    '-- falla, no queda nada a medias.',
    '-- ============================================================',
    '',
    'begin;',
    '',
    `create table if not exists ${TABLA_DE_CONTROL} (`,
    '  filename text primary key,',
    '  checksum text not null,',
    '  applied_at timestamptz not null default now()',
    ');',
    '',
  ];

  for (const nombre of archivos) {
    const sql = readFileSync(join(DIRECTORIO, nombre), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    partes.push(
      '-- ------------------------------------------------------------',
      `-- ${nombre}   sha256 ${checksum.slice(0, 16)}…`,
      '-- ------------------------------------------------------------',
      '',
      sql.trimEnd(),
      '',
      `insert into ${TABLA_DE_CONTROL} (filename, checksum)`,
      `values (${literal(nombre)}, ${literal(checksum)})`,
      'on conflict (filename) do nothing;',
      '',
    );
  }

  partes.push('commit;', '');

  const contenido = partes.join('\n');
  writeFileSync(destino, contenido, 'utf8');
  process.stdout.write(
    `SQL escrito en ${destino}\n` +
      `  ${archivos.length} migraciones · ${(contenido.length / 1024).toFixed(0)} KB\n` +
      `  ${archivos.join(' · ')}\n\n` +
      'Pegalo entero en el editor SQL del panel de Supabase y ejecutalo.\n',
  );
}

main();
