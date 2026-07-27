/**
 * CALIBRACION DEL CLASIFICADOR DE URGENCIA contra el modelo REAL.
 *
 *   npm run urgencia:calibrar
 *   npm run urgencia:calibrar -- --repeticiones 3   # el modelo es estocastico
 *   npm run urgencia:calibrar -- --verboso          # imprime cada veredicto
 *
 * POR QUE ESTO EXISTE COMO SCRIPT Y NO SOLO COMO TEST
 * El detector escalaba el 100% de los turnos y la bateria seguia en verde,
 * porque toda prueba de urgencias afirmaba que algo SI escala. Un clasificador
 * solo esta bien si acierta en las DOS direcciones, y eso hay que medirlo
 * contra el modelo de verdad —el modo dobles prueba que los controles atrapan
 * lo que el modelo pudiera decir, no lo que el modelo dice—.
 *
 * Esto se corre cuando cambie el modelo, el prompt o el esquema. La barrera
 * automatica esta en `tests/adversarial/bateria.test.ts`; esto es la lupa: da
 * la matriz de confusion y el detalle de cada caso, sin arrastrar la suite.
 *
 * CUESTA DINERO Y TARDA. Son ~21 llamadas por repeticion al modelo de
 * clasificacion, en serie.
 */
import 'dotenv/config';

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeService } from '../src/core/claude/claude.service.js';
import { PromptBuilder, loadPromptTemplates } from '../src/core/claude/prompt.builder.js';
import { UrgencyDetector, prefiltroLexico } from '../src/core/urgency/urgency.detector.js';
import {
  CASOS_LIMITE_URGENCIA,
  CASOS_SIN_URGENCIA,
  CASOS_URGENCIA_EXPLICITA,
  CASOS_URGENCIA_IMPLICITA,
} from '../tests/adversarial/casos.js';
import type { Logger } from '../src/core/types/index.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIRECTORIO_DE_PROMPTS = resolve(join(AQUI, '..', 'prompts'));

/** Silencioso: el informe lo imprime este script, no el logger. */
const loggerMudo: Logger = {
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => loggerMudo,
};

interface Grupo {
  nombre: string;
  casos: string[];
  /** Que se espera. `undefined` = zona gris, se mide pero no se juzga. */
  esperado: boolean | undefined;
  /** Por que importa equivocarse en este grupo. */
  costeDelError: string;
}

const GRUPOS: Grupo[] = [
  {
    nombre: 'urgencias explicitas',
    casos: CASOS_URGENCIA_EXPLICITA,
    esperado: true,
    costeDelError: 'FALSO NEGATIVO — un paciente en urgencia se queda en el flujo comercial',
  },
  {
    nombre: 'urgencias implicitas',
    casos: CASOS_URGENCIA_IMPLICITA,
    esperado: true,
    costeDelError: 'FALSO NEGATIVO — un paciente en urgencia se queda en el flujo comercial',
  },
  {
    nombre: 'consultas comerciales',
    casos: CASOS_SIN_URGENCIA,
    esperado: false,
    costeDelError: 'falso positivo — una derivacion innecesaria a recepcion',
  },
  {
    nombre: 'zona gris (informativo)',
    casos: CASOS_LIMITE_URGENCIA,
    esperado: undefined,
    costeDelError: 'ninguno: aqui escalar es el sesgo funcionando',
  },
];

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const FIN = '\x1b[0m';

async function main(): Promise<void> {
  const argumentos = process.argv.slice(2);
  const verboso = argumentos.includes('--verboso');
  const iRepeticiones = argumentos.indexOf('--repeticiones');
  const repeticiones = iRepeticiones === -1 ? 1 : Math.max(1, Number(argumentos[iRepeticiones + 1] ?? 1));

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    process.stdout.write('Falta ANTHROPIC_API_KEY. Esto mide contra el modelo real; sin clave no hay nada que medir.\n');
    process.exitCode = 1;
    return;
  }
  const modelo = process.env['CLAUDE_MODEL_CLASIFICACION'] ?? 'claude-haiku-4-5-20251001';

  const claude = new ClaudeService({
    config: { apiKey, modelPorDefecto: modelo, maxTokens: 300, temperature: 0 },
    logger: loggerMudo,
  });
  const promptBuilder = new PromptBuilder(await loadPromptTemplates(DIRECTORIO_DE_PROMPTS));
  const detector = new UrgencyDetector({
    claude,
    logger: loggerMudo,
    prompt: promptBuilder.promptDeUrgencia,
    model: modelo,
    // Holgado a proposito: aqui se mide el ACIERTO del clasificador, no su
    // latencia. Con el timeout de produccion un vencimiento caeria al modo
    // degradado y contaria como acierto del lexico, que no es lo que se mide.
    timeoutMs: 20_000,
  });

  process.stdout.write(
    `CALIBRACION DEL CLASIFICADOR DE URGENCIA\n` +
      `  modelo: ${modelo}  ·  repeticiones: ${repeticiones}\n\n`,
  );

  let falsosNegativos = 0;
  let falsosPositivos = 0;
  let totalDebia = 0;
  let totalNoDebia = 0;
  let aciertosClasificador = 0;
  let totalClasificador = 0;
  const latencias: number[] = [];

  for (const grupo of GRUPOS) {
    process.stdout.write(`${grupo.nombre}\n`);
    for (const caso of grupo.casos) {
      const viaLexico = prefiltroLexico(caso).length > 0;
      let escalo = 0;
      // El clasificador SOLO, sin pre-filtro: en una urgencia explicita el
      // lexico responde primero y el modelo no llega ni a hablar. Sin esto,
      // un clasificador degradado quedaria tapado justo en los casos graves.
      let clasificadorAcerto = 0;
      const veredictos: string[] = [];
      for (let i = 0; i < repeticiones; i += 1) {
        if ((await detector.detectUrgency(caso)).isUrgent) escalo += 1;
        const empezado = Date.now();
        const solo = await detector.clasificar(caso);
        latencias.push(Date.now() - empezado);
        veredictos.push(solo?.veredicto ?? 'ININTELIGIBLE');
        // Sin veredicto entendible tambien se escala, igual que en produccion.
        const escalariaSolo = solo === undefined || solo.veredicto !== 'sin_urgencia';
        if (grupo.esperado === undefined || escalariaSolo === grupo.esperado) clasificadorAcerto += 1;
      }

      let marca: string;
      if (grupo.esperado === undefined) {
        marca = escalo > 0 ? `${AMARILLO}escala   ${FIN}` : `${GRIS}no escala${FIN}`;
      } else if (grupo.esperado) {
        const fallos = repeticiones - escalo;
        falsosNegativos += fallos;
        totalDebia += repeticiones;
        marca = fallos === 0 ? `${VERDE}✓${FIN}` : `${ROJO}✗${FIN}`;
      } else {
        falsosPositivos += escalo;
        totalNoDebia += repeticiones;
        marca = escalo === 0 ? `${VERDE}✓${FIN}` : `${AMARILLO}!${FIN}`;
      }

      // El acierto del clasificador solo se cuenta aparte: cuando responde el
      // pre-filtro, el veredicto del modelo no interviene en produccion, pero
      // saber que HABRIA dicho es lo que detecta una degradacion silenciosa.
      if (grupo.esperado !== undefined) {
        totalClasificador += repeticiones;
        aciertosClasificador += clasificadorAcerto;
      }

      const proporcion = repeticiones > 1 ? ` ${escalo}/${repeticiones}` : '';
      const solo =
        clasificadorAcerto === repeticiones
          ? ''
          : `${ROJO} [clasificador solo: ${clasificadorAcerto}/${repeticiones}]${FIN}`;
      // El pre-filtro se senala porque un acierto suyo NO dice nada del
      // clasificador: es el camino rapido, no el modelo.
      const via = viaLexico ? `${GRIS} (pre-filtro lexico)${FIN}` : '';
      process.stdout.write(`  ${marca}${proporcion} ${caso.slice(0, 68)}${via}${solo}\n`);
      if (verboso) {
        process.stdout.write(`      ${GRIS}veredicto del modelo: ${veredictos.join(' · ')}${FIN}\n`);
      }
    }
    process.stdout.write('\n');
  }

  process.stdout.write('MATRIZ DE CONFUSION\n');
  process.stdout.write(
    `  falsos negativos: ${falsosNegativos}/${totalDebia}` +
      `   ${falsosNegativos === 0 ? VERDE + 'cero, que es el unico valor aceptable' : ROJO + 'HAY DANO'}${FIN}\n`,
  );
  process.stdout.write(
    `  falsos positivos: ${falsosPositivos}/${totalNoDebia}` +
      `   ${GRIS}coste operativo, tolerado por politica${FIN}\n`,
  );
  process.stdout.write(
    `  clasificador solo: ${aciertosClasificador}/${totalClasificador} aciertos` +
      `   ${GRIS}sin el respaldo del pre-filtro lexico${FIN}\n`,
  );

  // La latencia no es cosmetica: pasado el presupuesto, capa 3 cae al modo
  // degradado, que decide por lexico debil. Una urgencia implicita SIN lexico
  // se pierde ahi, y no deja rastro de que el clasificador la habria visto.
  const ordenadas = [...latencias].sort((a, b) => a - b);
  const p = (q: number): number => ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * q))] ?? 0;
  const presupuesto = 2500; // TIMEOUT_POR_DEFECTO_MS del detector
  const pasados = latencias.filter((l) => l > presupuesto).length;
  process.stdout.write(
    `  latencia p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${ordenadas.at(-1) ?? 0} ms\n` +
      `  por encima del presupuesto de ${presupuesto} ms: ${pasados}/${latencias.length}` +
      `   ${pasados === 0 ? GRIS + 'ninguno' : AMARILLO + 'caerian al modo degradado'}${FIN}\n\n`,
  );

  if (falsosNegativos > 0) {
    process.stdout.write('Un falso negativo deja a un paciente en urgencia dentro del flujo comercial.\n');
    process.exitCode = 1;
    return;
  }
  if (totalNoDebia > 0 && falsosPositivos === totalNoDebia) {
    process.stdout.write(
      'Escala TODO: acierta las urgencias por construccion, no por clasificar.\n' +
        'Es el defecto que este script existe para detectar.\n',
    );
    process.exitCode = 1;
  }
}

await main();
