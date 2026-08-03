/**
 * PREPARAR LA MAQUINA para correr el demo. Un comando, sin red.
 *
 *   npm run preparar
 *
 * Comprueba la version de Node y las dependencias, y sobre todo se ocupa del
 * `.env`, que es lo unico que no viaja en el repositorio:
 *
 *   - si NO existe, lo crea entero, comentado, con los valores no secretos ya
 *     puestos; solo quedan en blanco los secretos;
 *   - si YA existe, lo COMPLETA: añade al final las variables que falten y no
 *     toca ni una linea de las que ya estan. Es el caso normal al volver a una
 *     maquina donde el `.env` es anterior a alguna variable nueva.
 *
 * NO IMPRIME NINGUN VALOR, solo si esta puesto o no. Este script se ejecuta
 * cuando alguien mira la pantalla, y a veces hay alguien mas mirando.
 *
 * POR QUE UN GENERADOR Y NO UNA PLANTILLA VERSIONADA
 * Hubo un `.env.example` en el repositorio, alguien escribio dentro las claves
 * reales y viajaron a GitHub. Se borro y se purgo del historial. Un archivo con
 * forma de `.env` a mano de todos es una invitacion a rellenarlo, asi que el
 * esqueleto se genera en local, en una ruta que git ignora, y no se confirma
 * nunca.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { esEntradaPrincipal } from '../src/infra/entrada-principal.js';

const RAIZ = resolve(import.meta.dirname, '..');
const RUTA_ENV = join(RAIZ, '.env');
const NODE_MINIMO = 20;

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const NEGRITA = '\x1b[1m';
const FIN = '\x1b[0m';

// ---------------------------------------------------------------------------
// El esqueleto del .env
// ---------------------------------------------------------------------------

interface Variable {
  clave: string;
  /** Valor por defecto. Cadena vacia = es un secreto y lo pones tu. */
  valor: string;
  /** De donde sale. Solo se muestra para los secretos que falten. */
  procedencia?: string;
  /** Sin esto el demo no arranca. */
  imprescindible?: boolean;
}

interface Grupo {
  titulo: string;
  nota?: string;
  variables: Variable[];
}

/**
 * Los valores por defecto son los MEDIDOS, no los inventados: el umbral del RAG
 * es 0.5 porque 0.75 apagaba la recuperacion entera sobre la base aprobada, y
 * los modelos son los que se calibraron. Ver docs/ESTADO.md.
 */
export const GRUPOS: Grupo[] = [
  {
    titulo: 'Proceso',
    variables: [
      { clave: 'NODE_ENV', valor: 'development' },
      { clave: 'PORT', valor: '3000' },
      { clave: 'LOG_LEVEL', valor: 'info' },
    ],
  },
  {
    titulo: 'Modelo — el cerebro, comun a los dos canales',
    nota: 'Dos niveles: uno rapido para clasificar, uno mayor para conversar.',
    variables: [
      {
        clave: 'ANTHROPIC_API_KEY',
        valor: '',
        procedencia: 'console.anthropic.com → Settings → API keys (de pago por uso)',
        imprescindible: true,
      },
      { clave: 'CLAUDE_MODEL_CONVERSACION', valor: 'claude-sonnet-5' },
      { clave: 'CLAUDE_MODEL_CLASIFICACION', valor: 'claude-haiku-4-5-20251001' },
      { clave: 'CLAUDE_TEMPERATURE', valor: '0.3' },
      { clave: 'CLAUDE_MAX_TOKENS', valor: '1024' },
    ],
  },
  {
    titulo: 'Embeddings — sin esto el RAG no recupera nada',
    nota: 'Anthropic no da embeddings; por eso hace falta un segundo proveedor.',
    variables: [
      {
        clave: 'VOYAGE_API_KEY',
        valor: '',
        procedencia: 'dash.voyageai.com → API keys (plan gratuito: 3 peticiones/minuto)',
        imprescindible: true,
      },
      { clave: 'EMBEDDING_MODEL', valor: 'voyage-3' },
      { clave: 'EMBEDDING_DIMENSIONS', valor: '1024' },
      // 0.75 dejaba fuera el fragmento que responde literalmente la pregunta.
      { clave: 'RAG_UMBRAL_SIMILITUD', valor: '0.5' },
    ],
  },
  {
    titulo: 'Datos',
    nota: 'La clave service_role SALTA Row Level Security. Es de servidor: nunca en un navegador.',
    variables: [
      {
        clave: 'SUPABASE_URL',
        valor: '',
        procedencia: 'Supabase → Project Settings → Data API → Project URL',
        imprescindible: true,
      },
      {
        clave: 'SUPABASE_SERVICE_KEY',
        valor: '',
        procedencia: 'Supabase → Project Settings → API keys → service_role',
        imprescindible: true,
      },
      {
        clave: 'SUPABASE_DB_URL',
        valor: '',
        procedencia: 'Supabase → Project Settings → Database → Connection string (solo para migraciones)',
      },
      { clave: 'RETENCION_TRANSCRIPCION_DIAS', valor: '365' },
      { clave: 'RETENCION_AUDIO_DIAS', valor: '0' },
    ],
  },
  {
    titulo: 'Agenda',
    nota: 'El JSON de la cuenta de servicio, en una linea o en base64. El id del calendario NO va aqui: va en clinic.config.',
    variables: [
      {
        clave: 'GOOGLE_CALENDAR_CREDENTIALS',
        valor: '',
        procedencia: 'console.cloud.google.com → IAM → cuenta de servicio → clave JSON',
      },
    ],
  },
  {
    titulo: 'Canal de voz (ElevenLabs)',
    nota: 'Con VOICE_ENABLED=true se vuelven obligatorias la clave, el agente, los dos secretos y la lista blanca.',
    variables: [
      { clave: 'VOICE_ENABLED', valor: 'false' },
      { clave: 'ELEVENLABS_API_KEY', valor: '' },
      { clave: 'ELEVENLABS_AGENT_ID', valor: '' },
      { clave: 'ELEVENLABS_VOICE_ID', valor: '' },
      { clave: 'ELEVENLABS_MODEL', valor: '' },
      { clave: 'ELEVENLABS_WS_URL', valor: '' },
      { clave: 'VOICE_GATEWAY_URL', valor: '' },
      { clave: 'VOICE_GATEWAY_SECRET', valor: '' },
      { clave: 'ELEVENLABS_WEBHOOK_SECRET', valor: '' },
      { clave: 'VOICE_LATENCIA_OBJETIVO_MS', valor: '1200' },
      { clave: 'VOICE_BUFFER_WORD_MS', valor: '700' },
      { clave: 'AUDIO_RETENTION', valor: 'false' },
    ],
  },
  {
    titulo: 'Telefonia',
    nota: 'TRANSFER_WHITELIST son numeros REALES de personas que contestan. Sin ella no se escala una urgencia por telefono.',
    variables: [
      { clave: 'SIP_PROVIDER', valor: '' },
      { clave: 'TWILIO_ACCOUNT_SID', valor: '' },
      { clave: 'TWILIO_AUTH_TOKEN', valor: '' },
      { clave: 'TWILIO_PHONE_NUMBER', valor: '' },
      { clave: 'TRANSFER_WHITELIST', valor: '' },
    ],
  },
  {
    titulo: 'Canal de texto (WhatsApp)',
    nota: 'APP_SECRET firma el HMAC; WEBHOOK_SECRET solo responde al challenge. Son credenciales DISTINTAS.',
    variables: [
      { clave: 'WHATSAPP_ENABLED', valor: 'false' },
      { clave: 'WHATSAPP_BSP_TOKEN', valor: '' },
      { clave: 'WHATSAPP_PHONE_ID', valor: '' },
      { clave: 'WHATSAPP_WEBHOOK_SECRET', valor: '' },
      { clave: 'WHATSAPP_APP_SECRET', valor: '' },
    ],
  },
  {
    titulo: 'Orquestacion',
    nota: 'Sin N8N_WEBHOOK_URL, un escalamiento que no se pueda transferir por telefono NO llega a nadie.',
    variables: [{ clave: 'N8N_WEBHOOK_URL', valor: '' }],
  },
  {
    titulo: 'Continuidad',
    variables: [
      { clave: 'VENTANA_CONTINUIDAD_HORAS', valor: '72' },
      { clave: 'DEFAULT_PHONE_REGION', valor: 'PE' },
      // La clinica de demostracion que ya esta sembrada y aprobada.
      { clave: 'CLINIC_ID', valor: '00000000-0000-4000-8000-000000000001' },
      { clave: 'CLINIC_NAME', valor: 'Clinica Dental Aurora' },
    ],
  },
];

export const TODAS_LAS_VARIABLES: Variable[] = GRUPOS.flatMap((g) => g.variables);

const CABECERA = `# Configuracion local de Recepcion-IA. NO se versiona: git lo ignora.
#
# Generado por \`npm run preparar\`. Puedes volver a ejecutarlo cuando quieras:
# añade las variables que falten y no toca los valores que ya escribiste.
#
# Ninguna clave de este archivo debe acabar en un commit ni en un chat. Si una
# se escapa, no basta con borrarla despues: se queda en el historial y sigue
# siendo valida hasta que se rota en el proveedor.
`;

export function generarEsqueleto(): string {
  const partes = [CABECERA];
  for (const grupo of GRUPOS) {
    partes.push(`\n# --- ${grupo.titulo} ${'-'.repeat(Math.max(0, 68 - grupo.titulo.length))}`);
    if (grupo.nota) partes.push(`# ${grupo.nota}`);
    for (const v of grupo.variables) {
      if (v.valor === '' && v.procedencia) partes.push(`# ${v.clave}: ${v.procedencia}`);
      partes.push(`${v.clave}=${v.valor}`);
    }
  }
  return partes.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Lectura del .env existente
// ---------------------------------------------------------------------------

/**
 * Claves presentes y si tienen valor. No devuelve los valores: nada de este
 * script necesita conocerlos, y lo que no se lee no se puede imprimir por error.
 */
export function clavesDe(contenido: string): Map<string, boolean> {
  const claves = new Map<string, boolean>();
  for (const linea of contenido.split(/\r?\n/)) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const igual = limpia.indexOf('=');
    if (igual <= 0) continue;
    const clave = limpia.slice(0, igual).trim().replace(/^export\s+/, '');
    claves.set(clave, limpia.slice(igual + 1).trim() !== '');
  }
  return claves;
}

/**
 * Añade al final las variables ausentes. **No reescribe el archivo**: se
 * concatena. Un `.env` es trabajo manual de alguien —comentarios, orden,
 * valores a medio poner— y reordenarlo «para dejarlo bonito» es la clase de
 * ayuda que hace perder una hora buscando que cambio.
 */
export function completar(contenido: string, variables: Variable[] = TODAS_LAS_VARIABLES): {
  contenido: string;
  añadidas: string[];
} {
  const existentes = clavesDe(contenido);
  const faltan = variables.filter((v) => !existentes.has(v.clave));
  if (faltan.length === 0) return { contenido, añadidas: [] };

  const fecha = new Date().toISOString().slice(0, 10);
  const bloque = [
    '',
    `# --- Añadido por \`npm run preparar\` el ${fecha} ${'-'.repeat(28)}`,
    ...faltan.flatMap((v) =>
      v.valor === '' && v.procedencia ? [`# ${v.clave}: ${v.procedencia}`, `${v.clave}=`] : [`${v.clave}=${v.valor}`],
    ),
    '',
  ].join('\n');

  const base = contenido.endsWith('\n') ? contenido : contenido + '\n';
  return { contenido: base + bloque, añadidas: faltan.map((v) => v.clave) };
}

// ---------------------------------------------------------------------------
// Comprobaciones del entorno
// ---------------------------------------------------------------------------

export function versionDeNodeSuficiente(version: string, minimo = NODE_MINIMO): boolean {
  const mayor = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return mayor >= minimo;
}

function gitIgnora(ruta: string): boolean | undefined {
  try {
    execFileSync('git', ['check-ignore', '-q', ruta], { cwd: RAIZ, stdio: 'ignore' });
    return true;
  } catch (error) {
    // Codigo 1 = no esta ignorado. Cualquier otro = git no pudo responder
    // (no hay repositorio, no hay git), y eso NO es lo mismo que «no ignorado».
    const codigo = (error as { status?: number }).status;
    return codigo === 1 ? false : undefined;
  }
}

// ---------------------------------------------------------------------------

function main(): void {
  const linea = (texto = ''): void => {
    process.stdout.write(texto + '\n');
  };
  let hayProblema = false;

  linea(`\n${NEGRITA}PREPARAR RECEPCION-IA${FIN}\n`);

  // --- Node
  if (versionDeNodeSuficiente(process.version)) {
    linea(`${VERDE}✓${FIN} Node ${process.version}`);
  } else {
    hayProblema = true;
    linea(`${ROJO}✗${FIN} Node ${process.version} — hace falta ${NODE_MINIMO} o superior`);
    linea(`    descargalo en https://nodejs.org (version LTS)`);
  }

  // --- Dependencias
  if (existsSync(join(RAIZ, 'node_modules'))) {
    linea(`${VERDE}✓${FIN} dependencias instaladas`);
  } else {
    hayProblema = true;
    linea(`${ROJO}✗${FIN} falta node_modules — ejecuta ${NEGRITA}npm install${FIN}`);
  }

  // --- .env
  const existia = existsSync(RUTA_ENV);
  if (!existia) {
    writeFileSync(RUTA_ENV, generarEsqueleto(), 'utf8');
    linea(`${VERDE}✓${FIN} .env creado con todas las variables`);
  } else {
    const { contenido, añadidas } = completar(readFileSync(RUTA_ENV, 'utf8'));
    if (añadidas.length > 0) {
      writeFileSync(RUTA_ENV, contenido, 'utf8');
      linea(`${VERDE}✓${FIN} .env completado — ${añadidas.length} variable(s) añadida(s) al final:`);
      linea(`    ${GRIS}${añadidas.join(', ')}${FIN}`);
      linea(`    ${GRIS}no se ha tocado ningun valor de los que ya tenias${FIN}`);
    } else {
      linea(`${VERDE}✓${FIN} .env ya tiene todas las variables`);
    }
  }

  // --- Que git lo ignore, antes de que nadie escriba una clave dentro
  const ignorado = gitIgnora('.env');
  if (ignorado === true) {
    linea(`${VERDE}✓${FIN} git ignora .env`);
  } else if (ignorado === false) {
    hayProblema = true;
    linea(`${ROJO}✗${FIN} git NO ignora .env — no escribas ninguna clave hasta arreglarlo`);
  } else {
    linea(`${AMARILLO}!${FIN} no se pudo preguntar a git si ignora .env (¿es esto un repositorio?)`);
  }

  // --- Que falta por rellenar
  const presentes = clavesDe(readFileSync(RUTA_ENV, 'utf8'));
  const vacias = TODAS_LAS_VARIABLES.filter((v) => v.valor === '' && presentes.get(v.clave) !== true);
  const imprescindibles = vacias.filter((v) => v.imprescindible);

  linea();
  if (imprescindibles.length === 0) {
    linea(`${VERDE}✓${FIN} los datos imprescindibles estan puestos`);
  } else {
    hayProblema = true;
    linea(`${ROJO}Faltan ${imprescindibles.length} dato(s) sin los que el demo no arranca:${FIN}`);
    for (const v of imprescindibles) {
      linea(`  ${NEGRITA}${v.clave}${FIN}`);
      linea(`    ${GRIS}${v.procedencia}${FIN}`);
    }
    linea(`\n  Abre ${NEGRITA}.env${FIN} y escribelos ahi. Nada de pegarlos en un chat.`);
  }

  const opcionales = vacias.filter((v) => !v.imprescindible && v.procedencia);
  if (opcionales.length > 0) {
    linea(`\n${GRIS}Sin poner, y el demo funciona igual: ${opcionales.map((v) => v.clave).join(', ')}${FIN}`);
  }

  // --- Siguiente paso
  linea();
  if (hayProblema) {
    linea(`Arregla lo de arriba y vuelve a ejecutar ${NEGRITA}npm run preparar${FIN}.`);
    process.exitCode = 1;
    return;
  }
  linea(`${NEGRITA}Siguiente:${FIN}`);
  linea(`  npm run diagnostico    ${GRIS}comprueba que cada proveedor responde de verdad${FIN}`);
  linea(`  npm run consola        ${GRIS}habla con el agente y mira las tres capas${FIN}`);
  linea(`  npm run consola -- --dobles   ${GRIS}sin gastar ni escribir en la base${FIN}`);
  linea();
}

if (esEntradaPrincipal(import.meta.url)) {
  main();
}
