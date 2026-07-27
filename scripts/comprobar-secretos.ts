/**
 * DETECTOR DE CREDENCIALES antes de que entren en el repositorio.
 *
 * Existe porque ya paso: `.env.example` esta versionado, alguien escribio ahi
 * las claves reales y viajaron a GitHub dentro de un commit. Un commit
 * posterior no las borra —el valor se queda en el historial y sigue siendo
 * valido hasta que se rota—, asi que la unica defensa util es la que actua
 * ANTES de confirmar.
 *
 *   npm run comprobar-secretos              # arbol de trabajo, archivos versionados
 *   npm run comprobar-secretos -- --staged  # solo lo que esta a punto de entrar
 *
 * El hook de `.githooks/pre-commit` invoca el modo `--staged`. Se instala solo
 * al hacer `npm install` (script `prepare` de package.json).
 *
 * NO PRETENDE SER EXHAUSTIVO. Reconoce las credenciales de los proveedores que
 * usa este proyecto y las formas genericas mas comunes. Que pase no demuestra
 * que no haya un secreto; que falle si demuestra que hay uno.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

interface Patron {
  nombre: string;
  re: RegExp;
}

/**
 * Los patrones se componen por trozos a proposito: escritos enteros, este
 * mismo archivo daria positivo al escanearse.
 */
const PATRONES: Patron[] = [
  { nombre: 'clave de API de Anthropic', re: new RegExp('sk-' + 'ant-api\\d{2}-[A-Za-z0-9_-]{20,}') },
  { nombre: 'clave de API de Voyage', re: new RegExp('\\bpa-' + '[A-Za-z0-9_-]{30,}') },
  { nombre: 'JSON Web Token (clave de servicio de Supabase)', re: new RegExp('eyJ' + 'hbGciOi[A-Za-z0-9_.-]{20,}') },
  { nombre: 'cadena de conexion de Postgres con contrasena', re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/ },
  { nombre: 'clave de API de ElevenLabs', re: new RegExp('\\bsk_' + '[a-f0-9]{40,}') },
  { nombre: 'clave privada PEM', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { nombre: 'clave de API de Google', re: new RegExp('\\bAIza' + '[A-Za-z0-9_-]{35}\\b') },
  { nombre: 'token de acceso de Meta/Facebook', re: new RegExp('\\bEAA' + '[A-Za-z0-9]{40,}') },
  { nombre: 'token de acceso de GitHub', re: new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{36,}') },
  { nombre: 'credenciales de AWS', re: new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b') },
  { nombre: 'identificador de cuenta de Twilio', re: new RegExp('\\bAC' + '[a-f0-9]{32}\\b') },
];

/** Archivos que contienen los patrones por definicion y no son un hallazgo. */
const EXENTOS = new Set(['scripts/comprobar-secretos.ts']);

/**
 * Marcas de que la linea es un EJEMPLO y no una credencial.
 *
 * Se aplica a cualquier archivo, no solo a las plantillas: la documentacion, los
 * mensajes de error de `migrate.ts` y las fixtures de las pruebas contienen
 * cadenas de conexion y claves PEM de mentira, y son legitimas. Se exige que el
 * marcador sea inequivoco —entre angulos, en mayusculas, una corrida de equis o
 * unos puntos suspensivos— para que un `password=loquesea` real no se escape
 * solo por llevar la palabra «password».
 */
const MARCAS_DE_EJEMPLO: RegExp[] = [
  /<[^>]{2,}>/, //            <password>, <project-ref>
  /\.\.\./, //                sk-ant-api03-...
  /x{4,}/i, //                db.xxxxx.supabase.co
  /\bTU[_-]?[A-Z]/, //        TU_PASSWORD, TU-PROYECTO
  // Sin fronteras de palabra: en una fixture la clave aparece como
  // `-----BEGIN PRIVATE KEY-----\nFAKEKEY\n...`, donde `FAKE` no tiene frontera
  // ni delante (la `n` del `\n` literal) ni detras (`KEY`).
  /(?:FAKE|DUMMY|CAMBIA|EJEMPLO|PLACEHOLDER|CONTRASENA|REGION|SECRETO)/i,
];

const pareceEjemplo = (linea: string): boolean => MARCAS_DE_EJEMPLO.some((re) => re.test(linea));

const BINARIO = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|wav)$/i;
const LIMITE_BYTES = 2_000_000;

interface Hallazgo {
  archivo: string;
  linea: number;
  patron: string;
  extracto: string;
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function archivosAExaminar(soloEnEspera: boolean): string[] {
  const salida = soloEnEspera
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    : git('ls-files');
  return salida.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** En modo `--staged` interesa el contenido del indice, no el del disco. */
function contenidoDe(archivo: string, soloEnEspera: boolean): string | undefined {
  try {
    if (soloEnEspera) return git('show', `:${archivo}`);
    if (!existsSync(archivo) || statSync(archivo).size > LIMITE_BYTES) return undefined;
    return readFileSync(archivo, 'utf8');
  } catch {
    return undefined;
  }
}

/** Recorta el hallazgo para poder senalarlo sin volver a imprimir el secreto. */
const censurar = (texto: string): string => {
  const limpio = texto.trim().replace(/\s+/g, ' ');
  return limpio.length <= 24 ? `${limpio.slice(0, 8)}…` : `${limpio.slice(0, 12)}…${limpio.slice(-4)}`;
};

function examinar(soloEnEspera: boolean): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  for (const archivo of archivosAExaminar(soloEnEspera)) {
    if (EXENTOS.has(archivo) || BINARIO.test(archivo)) continue;
    const contenido = contenidoDe(archivo, soloEnEspera);
    if (contenido === undefined) continue;

    contenido.split('\n').forEach((linea, indice) => {
      if (pareceEjemplo(linea)) return;
      for (const { nombre, re } of PATRONES) {
        const m = re.exec(linea);
        if (m) {
          hallazgos.push({ archivo, linea: indice + 1, patron: nombre, extracto: censurar(m[0]) });
          break;
        }
      }
    });
  }
  return hallazgos;
}

const soloEnEspera = process.argv.includes('--staged');
const hallazgos = examinar(soloEnEspera);
const ambito = soloEnEspera ? 'lo que esta a punto de confirmarse' : 'los archivos versionados';

if (hallazgos.length === 0) {
  process.stdout.write(`✓ sin credenciales detectadas en ${ambito}\n`);
  process.exit(0);
}

process.stdout.write(`\n✗ CREDENCIALES DETECTADAS en ${ambito}\n\n`);
for (const h of hallazgos) {
  process.stdout.write(`  ${h.archivo}:${h.linea}\n     ${h.patron} — ${h.extracto}\n`);
}
process.stdout.write(
  '\nUna credencial confirmada NO se borra con un commit posterior: se queda en\n' +
    'el historial y sigue siendo valida hasta que se rota.\n\n' +
    'Los valores reales van en `.env` (que git ignora) o en `credenciales/`.\n' +
    'En `.env.example` solo marcadores.\n\n' +
    'Si de verdad es un falso positivo, confirma con `git commit --no-verify`.\n',
);
process.exit(1);
