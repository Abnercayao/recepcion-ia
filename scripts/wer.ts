/**
 * Medicion de la tasa de error de palabra (WER) por segmento de hablante.
 *
 * Es el instrumental de la Fase 7 (control C5 del informe etico: "Equidad del
 * reconocimiento del habla y salidas alternativas"; riesgo A.1: sesgo de
 * reconocimiento del habla por variedad dialectal). Este script NO produce una
 * linea base: produce la HERRAMIENTA con la que, cuando existan hablantes
 * reales con consentimiento informado (ver docs/plantillas/consentimiento-informado.md),
 * se calcula esa linea base de forma reproducible. Ver docs/fase7-equidad.md
 * para el protocolo completo (que segmentos medir, cuantos hablantes hacen
 * falta, y el umbral de brecha que bloquea el despliegue de voz).
 *
 * ALGORITMO: distancia de edicion a nivel de PALABRA (Levenshtein) por
 * programacion dinamica, sin librerias externas. WER = (S + I + D) / N, donde
 * N son las palabras de la REFERENCIA (la transcripcion humana correcta) y
 * S/I/D son sustituciones, inserciones y eliminaciones necesarias para
 * convertir la referencia en la hipotesis (lo que transcribio el ASR).
 *
 * ENTRADA: un archivo JSON con un array de pares. Se eligio JSON sobre CSV
 * porque el texto de referencia/hipotesis en espanol coloquial puede contener
 * comas, comillas y saltos de linea, y escapar eso correctamente en CSV es mas
 * fragil que dejar que JSON.parse lo resuelva. Forma de cada elemento:
 *
 *   {
 *     "hablante_id": "h07",          // identificador del hablante (no el nombre real: ver plantilla de consentimiento)
 *     "segmento": "andino_mayor",    // etiqueta del segmento dialectal/demografico (ver fase7-equidad.md)
 *     "referencia": "cuatro y media de la tarde",
 *     "hipotesis": "4:30 de la tarde",
 *     "frase_id": "hora_cita_1"      // opcional, para poder auditar el guion de captura
 *   }
 *
 * SALIDA: reporte por consola (WER global, por segmento, y la BRECHA entre el
 * mejor y el peor segmento), mas export opcional a JSON y a Markdown (este
 * ultimo pensado para pegarse literal en el Anexo B del informe etico).
 *
 * USO:
 *   npx tsx scripts/wer.ts --input datos.json
 *   npx tsx scripts/wer.ts --input datos.json --out-json salida.json --out-md salida.md
 *   npx tsx scripts/wer.ts --input datos.json --umbral-brecha 0.10 --min-hablantes 15 --min-absoluto 5
 *
 * CODIGOS DE SALIDA (para poder usarlo como gate de despliegue en CI):
 *   0 = brecha dentro del umbral Y todos los segmentos comparados tienen
 *       muestra suficiente.
 *   1 = BLOQUEO: la brecha supera el umbral, o la comparacion se apoya en un
 *       segmento con menos hablantes que el minimo absoluto, o no hay al
 *       menos dos segmentos con datos para comparar. Un WER que no se puede
 *       comparar no autoriza nada; se trata igual que una brecha excedida.
 *   2 = error de uso o de entrada (archivo faltante, JSON invalido, etc.).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Normalizacion de texto (configurable y documentada, como exige el encargo)
// ---------------------------------------------------------------------------

export interface OpcionesNormalizacion {
  /** Pasa todo a minusculas antes de comparar. */
  minusculas: boolean;
  /** Quita signos de puntuacion (no afecta letras ni numeros). */
  quitarPuntuacion: boolean;
  /** Quita tildes y normaliza la ene con virgulilla a 'n'. */
  quitarTildes: boolean;
  /**
   * Convierte numeros (y horas tipo "4:30") a su forma hablada en espanol.
   * Existe porque "4:30" frente a "cuatro y media" NO es un error de
   * reconocimiento del habla: es una diferencia de formato entre como se
   * escribio la referencia y como transcribe el ASR. Contarlo como error
   * infla artificialmente el WER de cualquier segmento cuyo guion de captura
   * use horas o cantidades. Ver `convertirNumerosATexto` para el alcance
   * exacto (y sus limites) de esta conversion.
   */
  numerosComoPalabras: boolean;
}

export const NORMALIZACION_POR_DEFECTO: OpcionesNormalizacion = {
  minusculas: true,
  quitarPuntuacion: true,
  quitarTildes: true,
  numerosComoPalabras: true,
};

const UNIDADES = [
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
] as const;

const DIEZ_A_DIECINUEVE = [
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
] as const;

const DECENAS = [
  '', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa',
] as const;

const CENTENAS = [
  '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos',
] as const;

function convertirDosDigitos(n: number): string {
  if (n < 10) return UNIDADES[n] as string;
  if (n < 20) return DIEZ_A_DIECINUEVE[n - 10] as string;
  if (n < 30) return n === 20 ? 'veinte' : 'veinti' + (UNIDADES[n - 20] as string);
  const decena = Math.floor(n / 10);
  const unidad = n % 10;
  return unidad === 0 ? (DECENAS[decena] as string) : `${DECENAS[decena]} y ${UNIDADES[unidad]}`;
}

function convertirTresDigitos(n: number): string {
  if (n === 100) return 'cien';
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (centena > 0) partes.push(CENTENAS[centena] as string);
  if (resto > 0) partes.push(convertirDosDigitos(resto));
  return partes.join(' ');
}

/**
 * Aplica la apocope "uno" -> "un" antes de "mil" (veintiuno mil -> veintiun mil).
 * Sin `\b` delante: "veintiuno" es una sola palabra (sin espacio antes de
 * "uno"), asi que un limite de palabra ahi nunca haria match. El sufijo
 * "uno" es suficiente porque esta funcion solo recibe vocabulario controlado
 * (la salida de `convertirTresDigitos`).
 */
function conApocopeDeMil(texto: string): string {
  return texto.replace(/uno$/, 'un');
}

/**
 * Convierte un entero no negativo a su forma en palabras, en espanol.
 *
 * ALCANCE Y LIMITES (documentados a proposito, no un descuido):
 * - Cubre 0 a 999999. Fuera de ese rango devuelve el numero tal cual (no
 *   inventa una forma en millones sin poder verificarla).
 * - No aplica concordancia de genero (asume la forma masculina: "doscientos",
 *   no "doscientas"). Si una referencia real usa "doscientas citas", la
 *   normalizacion no la igualara a "200 citas"; es una limitacion conocida.
 * - La apocope de "uno" -> "un" solo se aplica antes de "mil", no en general
 *   ("veintiun" en aislado seguiria siendo "veintiuno").
 * - No maneja decimales ni negativos mas alla del signo simple.
 */
export function numeroAPalabras(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 999999) {
    return String(n);
  }
  if (n === 0) return 'cero';
  if (n < 100) return convertirDosDigitos(n);
  if (n < 1000) return convertirTresDigitos(n);

  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const partes: string[] = [];
  partes.push(miles === 1 ? 'mil' : `${conApocopeDeMil(convertirTresDigitos(miles))} mil`);
  if (resto > 0) partes.push(convertirTresDigitos(resto));
  return partes.join(' ');
}

/** Convierte una hora "H:MM" ya separada en sus componentes a su forma hablada. */
function convertirHoraAPalabras(hora: number, minuto: number): string {
  const horaTexto = numeroAPalabras(hora);
  if (minuto === 0) return `${horaTexto} en punto`;
  if (minuto === 15) return `${horaTexto} y cuarto`;
  if (minuto === 30) return `${horaTexto} y media`;
  return `${horaTexto} y ${numeroAPalabras(minuto)}`;
}

const PATRON_HORA = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const PATRON_ENTERO = /\d+/g;

/**
 * Reemplaza digitos y horas "H:MM" por su forma hablada en espanol.
 *
 * Corre ANTES de quitar puntuacion (la hora depende del ":") y antes de
 * pasar a minusculas (no importa para digitos, pero mantiene el orden
 * explicito). No intenta adivinar am/pm ni convertir de 24h a 12h: "16:30" se
 * convierte a "dieciseis y media", no a "cuatro y media de la tarde". Si el
 * guion de captura (docs/fase7-equidad.md) usa siempre el mismo formato de
 * hora en la referencia y dentro de lo transcrito, esto es suficiente; si un
 * lado usa 12h y el otro 24h, esa diferencia debe resolverse en el guion de
 * captura, no aqui, porque adivinar el turno del dia introduciria errores
 * mas dificiles de auditar que el problema que se intenta resolver.
 */
export function convertirNumerosATexto(texto: string): string {
  let resultado = texto.replace(PATRON_HORA, (_m, h: string, min: string) =>
    convertirHoraAPalabras(Number(h), Number(min)),
  );
  resultado = resultado.replace(PATRON_ENTERO, (m) => numeroAPalabras(Number(m)));
  return resultado;
}

/**
 * Punto de codigo donde empieza y termina el bloque unicode de diacriticos
 * combinantes (tildes, virgulillas, etc. una vez separados de su letra base
 * por `normalize('NFD')`). Se trabaja por PUNTO DE CODIGO NUMERICO, nunca con
 * el caracter acentuado literal en el fuente, siguiendo la regla del
 * contrato de construccion de evitar tildes/enes en el codigo por
 * codificacion en Windows. Ejemplo: 'nino'.normalize('NFD') separa la ene con
 * virgulilla en 'n' + un caracter en este rango; al quitarlo queda 'nino'.
 */
const DIACRITICO_COMBINANTE_DESDE = 0x0300;
const DIACRITICO_COMBINANTE_HASTA = 0x036f;

/** Quita diacriticos (tildes, virgulilla de la ene) trabajando por punto de codigo. */
function quitarTildesDeTexto(texto: string): string {
  let resultado = '';
  for (const caracter of texto.normalize('NFD')) {
    const codigo = caracter.codePointAt(0) ?? 0;
    if (codigo >= DIACRITICO_COMBINANTE_DESDE && codigo <= DIACRITICO_COMBINANTE_HASTA) continue;
    resultado += caracter;
  }
  return resultado;
}

/**
 * Puntos de codigo de puntuacion a eliminar (reemplazada por un espacio).
 * Incluye la puntuacion ASCII comun mas los signos de apertura invertidos y
 * las comillas angulares del espanol, y el guion medio/largo, todos por
 * punto de codigo numerico para no llevar el caracter literal en el fuente:
 *   0xa1 = signo de apertura de exclamacion invertido
 *   0xbf = signo de apertura de interrogacion invertido
 *   0xab, 0xbb = comillas angulares (apertura y cierre)
 *   0x2013, 0x2014 = guion medio (en dash) y guion largo (em dash)
 */
const CODIGOS_PUNTUACION_NO_ASCII = [0xa1, 0xbf, 0xab, 0xbb, 0x2013, 0x2014];

function esPuntuacionAscii(codigo: number): boolean {
  const PUNTUACION_ASCII = '.,;:!?"\'()[]{}/\\-';
  return PUNTUACION_ASCII.includes(String.fromCharCode(codigo));
}

/** Reemplaza la puntuacion por un espacio. Ver comentario de `CODIGOS_PUNTUACION_NO_ASCII`. */
function quitarPuntuacionDeTexto(texto: string): string {
  let resultado = '';
  for (const caracter of texto) {
    const codigo = caracter.codePointAt(0) ?? 0;
    if (esPuntuacionAscii(codigo) || CODIGOS_PUNTUACION_NO_ASCII.includes(codigo)) {
      resultado += ' ';
    } else {
      resultado += caracter;
    }
  }
  return resultado;
}

/** Aplica la normalizacion configurada. Documentar cualquier cambio aqui: afecta la cifra de WER. */
export function normalizarTexto(
  texto: string,
  opciones: OpcionesNormalizacion = NORMALIZACION_POR_DEFECTO,
): string {
  let resultado = texto;
  if (opciones.numerosComoPalabras) resultado = convertirNumerosATexto(resultado);
  if (opciones.minusculas) resultado = resultado.toLowerCase();
  if (opciones.quitarTildes) resultado = quitarTildesDeTexto(resultado);
  if (opciones.quitarPuntuacion) resultado = quitarPuntuacionDeTexto(resultado);
  return resultado;
}

/** Separa el texto normalizado en palabras (colapsa espacios multiples). */
export function tokenizar(textoNormalizado: string): string[] {
  return textoNormalizado
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// 2. Distancia de edicion a nivel de palabra, con programacion dinamica
// ---------------------------------------------------------------------------

export interface OperacionesEdicion {
  sustituciones: number;
  inserciones: number;
  eliminaciones: number;
  distancia: number;
}

/**
 * Calcula sustituciones, inserciones y eliminaciones para convertir `ref` en
 * `hip` con la MINIMA cantidad de operaciones (algoritmo de Levenshtein
 * clasico, sin libreria). La suma S+I+D siempre coincide con la distancia
 * minima; cuando hay empates entre varias secuencias de operaciones optimas,
 * la clasificacion exacta de CUAL operacion ocurrio en un punto dado puede
 * variar segun el orden de desempate. Es una propiedad conocida del calculo
 * de WER (la usan por igual herramientas de referencia como sclite) y no
 * afecta el total de errores, solo el desglose fino en casos ambiguos.
 */
export function calcularOperacionesEdicion(ref: readonly string[], hip: readonly string[]): OperacionesEdicion {
  const n = ref.length;
  const m = hip.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i]![0] = i;
  for (let j = 0; j <= m; j += 1) dp[0]![j] = j;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (ref[i - 1] === hip[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] = 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  let i = n;
  let j = m;
  let sustituciones = 0;
  let inserciones = 0;
  let eliminaciones = 0;

  while (i > 0 || j > 0) {
    const actual = dp[i]![j]!;
    if (i > 0 && j > 0 && ref[i - 1] === hip[j - 1] && actual === dp[i - 1]![j - 1]!) {
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && actual === dp[i - 1]![j - 1]! + 1) {
      sustituciones += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && actual === dp[i - 1]![j]! + 1) {
      eliminaciones += 1;
      i -= 1;
    } else if (j > 0 && actual === dp[i]![j - 1]! + 1) {
      inserciones += 1;
      j -= 1;
    } else {
      // No deberia alcanzarse con una tabla DP correcta. Guarda de seguridad
      // para no entrar en bucle infinito si algun dia cambia el algoritmo.
      break;
    }
  }

  return { sustituciones, inserciones, eliminaciones, distancia: dp[n]![m]! };
}

// ---------------------------------------------------------------------------
// 3. Evaluacion por par y agregacion por segmento
// ---------------------------------------------------------------------------

const parEntradaSchema = z.object({
  hablante_id: z.string().min(1, 'hablante_id no puede estar vacio'),
  segmento: z.string().min(1, 'segmento no puede estar vacio'),
  referencia: z.string(),
  hipotesis: z.string(),
  frase_id: z.string().optional(),
});

export type ParEntrada = z.infer<typeof parEntradaSchema>;

const entradaSchema = z.array(parEntradaSchema).min(1, 'el archivo de entrada no tiene ningun par');

export interface ResultadoPar extends ParEntrada {
  palabrasReferencia: number;
  sustituciones: number;
  inserciones: number;
  eliminaciones: number;
  /**
   * WER de este par. `null` unicamente cuando la referencia esta vacia pero
   * la hipotesis no: la formula (errores / palabras de referencia) implica
   * dividir entre cero, y reportar un numero ahi seria fabricar una cifra.
   * Se marca como indefinido en vez de ocultarlo o forzarlo a 0 o a 100.
   */
  wer: number | null;
}

/** Evalua un par referencia/hipotesis aplicando la normalizacion dada. */
export function evaluarPar(par: ParEntrada, opciones: OpcionesNormalizacion = NORMALIZACION_POR_DEFECTO): ResultadoPar {
  const refTokens = tokenizar(normalizarTexto(par.referencia, opciones));
  const hipTokens = tokenizar(normalizarTexto(par.hipotesis, opciones));
  const { sustituciones, inserciones, eliminaciones } = calcularOperacionesEdicion(refTokens, hipTokens);
  const palabrasReferencia = refTokens.length;
  const errores = sustituciones + inserciones + eliminaciones;
  const wer = palabrasReferencia === 0 ? (hipTokens.length === 0 ? 0 : null) : errores / palabrasReferencia;
  return { ...par, palabrasReferencia, sustituciones, inserciones, eliminaciones, wer };
}

export interface UmbralesHablantes {
  /** Por debajo de esto, el WER del segmento no es un dato: es ruido. Se reporta pero marcado como no concluyente. */
  minimoAbsoluto: number;
  /** Por debajo de esto, el WER se reporta pero no alcanza para sostener una decision de despliegue. */
  recomendado: number;
}

export const UMBRALES_POR_DEFECTO: UmbralesHablantes = {
  minimoAbsoluto: 5,
  recomendado: 15,
};

/**
 * Brecha maxima aceptable entre el mejor y el peor segmento, en puntos de
 * WER (0.10 = 10 puntos porcentuales). VACIO DE LA ESPECIFICACION: ningun
 * documento fuente fija un numero. Se elige 10 puntos como punto de partida
 * razonado y documentado en docs/fase7-equidad.md, ajustable por
 * `--umbral-brecha`; debe recalibrarse cuando exista una linea base real.
 */
export const UMBRAL_BRECHA_POR_DEFECTO = 0.1;

export type NivelConfianzaMuestra = 'insuficiente' | 'minimo' | 'recomendado';

export interface IntervaloConfianza {
  inferior: number;
  superior: number;
}

/**
 * Intervalo de Wilson para una proporcion, usado como aproximacion del
 * intervalo de confianza del WER tratando cada palabra de referencia como un
 * ensayo binario (correcta/incorrecta). Es una APROXIMACION, no un intervalo
 * exacto de WER: el WER puede superar 1.0 por las inserciones (mas palabras
 * "de mas" que palabras de referencia), y la formula de Wilson asume una
 * proporcion entre 0 y 1. Si el WER del segmento supera 1.0 esta funcion
 * devuelve `null` en vez de un intervalo invalido, y el llamador debe
 * advertirlo (ver `agregarSegmento`). Ademas, los errores entre palabras
 * consecutivas de una misma frase no son independientes entre si (si el ASR
 * falla con un acento, tiende a fallar en rafaga), por lo que el intervalo
 * real es mas ancho que el que devuelve esta formula: se reporta como
 * indicativo, no como garantia estadistica.
 */
export function intervaloWilson(errores: number, n: number, z = 1.96): IntervaloConfianza | null {
  if (n <= 0) return null;
  const p = errores / n;
  if (p > 1) return null;
  const denominador = 1 + (z * z) / n;
  const centro = p + (z * z) / (2 * n);
  const margen = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    inferior: Math.max(0, (centro - margen) / denominador),
    superior: Math.min(1, (centro + margen) / denominador),
  };
}

export interface ResultadoSegmento {
  segmento: string;
  pares: ResultadoPar[];
  hablantes: string[];
  numHablantes: number;
  numPares: number;
  totalPalabrasReferencia: number;
  totalSustituciones: number;
  totalInserciones: number;
  totalEliminaciones: number;
  /** WER agregado a nivel de CORPUS: suma de errores / suma de palabras de referencia del segmento. */
  wer: number | null;
  intervalo: IntervaloConfianza | null;
  nivelConfianzaMuestra: NivelConfianzaMuestra;
}

/**
 * Agrega los resultados de un segmento.
 *
 * DECISION DE DISENO: el WER del segmento es (suma de errores) / (suma de
 * palabras de referencia), NO el promedio de los WER por par. Promediar WER
 * por frase da el mismo peso a una frase de 2 palabras que a una de 20, lo
 * que sesga el resultado hacia las frases cortas. Sumando antes de dividir,
 * una frase larga pesa lo que le corresponde: es el estandar de facto en
 * medicion de ASR (WER "a nivel de corpus").
 */
export function agregarSegmento(
  segmento: string,
  pares: ResultadoPar[],
  umbrales: UmbralesHablantes = UMBRALES_POR_DEFECTO,
): ResultadoSegmento {
  const hablantes = [...new Set(pares.map((p) => p.hablante_id))].sort();
  const totalPalabrasReferencia = pares.reduce((acc, p) => acc + p.palabrasReferencia, 0);
  const totalSustituciones = pares.reduce((acc, p) => acc + p.sustituciones, 0);
  const totalInserciones = pares.reduce((acc, p) => acc + p.inserciones, 0);
  const totalEliminaciones = pares.reduce((acc, p) => acc + p.eliminaciones, 0);
  const totalErrores = totalSustituciones + totalInserciones + totalEliminaciones;
  const wer = totalPalabrasReferencia === 0 ? null : totalErrores / totalPalabrasReferencia;
  const intervalo = wer === null ? null : intervaloWilson(totalErrores, totalPalabrasReferencia);

  const nivelConfianzaMuestra: NivelConfianzaMuestra =
    hablantes.length < umbrales.minimoAbsoluto
      ? 'insuficiente'
      : hablantes.length < umbrales.recomendado
        ? 'minimo'
        : 'recomendado';

  return {
    segmento,
    pares,
    hablantes,
    numHablantes: hablantes.length,
    numPares: pares.length,
    totalPalabrasReferencia,
    totalSustituciones,
    totalInserciones,
    totalEliminaciones,
    wer,
    intervalo,
    nivelConfianzaMuestra,
  };
}

// ---------------------------------------------------------------------------
// 4. La brecha: la cifra que decide el despliegue
// ---------------------------------------------------------------------------

export interface ResultadoBrecha {
  mejorSegmento: string;
  peorSegmento: string;
  werMejor: number;
  werPeor: number;
  /** Diferencia en puntos de WER (ej. 0.10 = 10 puntos porcentuales). */
  brechaAbsoluta: number;
  /** Cuantas veces peor es el peor segmento respecto del mejor. Infinity si el mejor es 0. */
  brechaRelativa: number;
  /** True si el mejor o el peor segmento comparado no alcanza el minimo absoluto de hablantes. */
  muestraInsuficiente: boolean;
}

/**
 * Calcula la brecha entre el segmento con menor y mayor WER.
 * Devuelve `null` si hay menos de dos segmentos con WER definido: una brecha
 * no se puede calcular con un solo punto de comparacion.
 */
export function calcularBrecha(segmentos: readonly ResultadoSegmento[]): ResultadoBrecha | null {
  const conDatos = segmentos.filter((s): s is ResultadoSegmento & { wer: number } => s.wer !== null);
  if (conDatos.length < 2) return null;

  const ordenado = [...conDatos].sort((a, b) => a.wer - b.wer);
  const mejor = ordenado[0]!;
  const peor = ordenado[ordenado.length - 1]!;

  return {
    mejorSegmento: mejor.segmento,
    peorSegmento: peor.segmento,
    werMejor: mejor.wer,
    werPeor: peor.wer,
    brechaAbsoluta: peor.wer - mejor.wer,
    brechaRelativa: mejor.wer === 0 ? Infinity : peor.wer / mejor.wer,
    muestraInsuficiente:
      mejor.nivelConfianzaMuestra === 'insuficiente' || peor.nivelConfianzaMuestra === 'insuficiente',
  };
}

// ---------------------------------------------------------------------------
// 5. Orquestacion, reporte y CLI
// ---------------------------------------------------------------------------

export interface ResultadoGlobal {
  generadoEn: string;
  opcionesNormalizacion: OpcionesNormalizacion;
  umbrales: UmbralesHablantes;
  umbralBrecha: number;
  totalPares: number;
  totalPalabrasReferencia: number;
  wer: number | null;
  segmentos: ResultadoSegmento[];
  brecha: ResultadoBrecha | null;
  advertencias: string[];
}

export function evaluarConjunto(
  entradas: ParEntrada[],
  opciones: {
    normalizacion?: OpcionesNormalizacion;
    umbrales?: UmbralesHablantes;
    umbralBrecha?: number;
  } = {},
): ResultadoGlobal {
  const normalizacion = opciones.normalizacion ?? NORMALIZACION_POR_DEFECTO;
  const umbrales = opciones.umbrales ?? UMBRALES_POR_DEFECTO;
  const umbralBrecha = opciones.umbralBrecha ?? UMBRAL_BRECHA_POR_DEFECTO;

  const pares = entradas.map((p) => evaluarPar(p, normalizacion));

  const nombresSegmento = [...new Set(pares.map((p) => p.segmento))].sort();
  const segmentos = nombresSegmento.map((nombre) =>
    agregarSegmento(
      nombre,
      pares.filter((p) => p.segmento === nombre),
      umbrales,
    ),
  );

  const totalPalabrasReferencia = pares.reduce((acc, p) => acc + p.palabrasReferencia, 0);
  const totalErrores = pares.reduce((acc, p) => acc + p.sustituciones + p.inserciones + p.eliminaciones, 0);
  const wer = totalPalabrasReferencia === 0 ? null : totalErrores / totalPalabrasReferencia;

  const brecha = calcularBrecha(segmentos);

  const advertencias: string[] = [];
  for (const seg of segmentos) {
    if (seg.nivelConfianzaMuestra === 'insuficiente') {
      advertencias.push(
        `Segmento "${seg.segmento}": solo ${seg.numHablantes} hablante(s) (minimo absoluto: ` +
          `${umbrales.minimoAbsoluto}). El WER de este segmento es RUIDO, no una conclusion.`,
      );
    } else if (seg.nivelConfianzaMuestra === 'minimo') {
      advertencias.push(
        `Segmento "${seg.segmento}": ${seg.numHablantes} hablantes, por debajo del minimo ` +
          `recomendado (${umbrales.recomendado}) para sostener una decision de despliegue.`,
      );
    }
    if (seg.wer !== null && seg.wer > 1 && seg.intervalo === null) {
      advertencias.push(
        `Segmento "${seg.segmento}": WER > 100% (hay mas inserciones que palabras de referencia). ` +
          'No se reporta intervalo de confianza: la aproximacion de proporcion no aplica aqui.',
      );
    }
  }
  if (!brecha) {
    advertencias.push(
      'No hay al menos dos segmentos con WER definido: no se puede calcular la brecha. ' +
        'Sin brecha no hay forma de comparar segmentos ni de autorizar el despliegue de voz.',
    );
  } else if (brecha.muestraInsuficiente) {
    advertencias.push(
      `La brecha calculada (${(brecha.brechaAbsoluta * 100).toFixed(1)} puntos) involucra un segmento ` +
        'con muestra insuficiente. No es una base valida para autorizar ni para bloquear el despliegue: ' +
        'hacen falta mas hablantes en ese segmento antes de que la cifra signifique algo.',
    );
  }

  return {
    generadoEn: new Date().toISOString(),
    opcionesNormalizacion: normalizacion,
    umbrales,
    umbralBrecha,
    totalPares: pares.length,
    totalPalabrasReferencia,
    wer,
    segmentos,
    brecha,
    advertencias,
  };
}

function formatearPct(valor: number | null): string {
  if (valor === null) return 'indefinido';
  return `${(valor * 100).toFixed(1)}%`;
}

function formatearIntervalo(intervalo: IntervaloConfianza | null): string {
  if (!intervalo) return 'n/d';
  return `[${(intervalo.inferior * 100).toFixed(1)}%, ${(intervalo.superior * 100).toFixed(1)}%]`;
}

/**
 * Rellena `texto` hasta `ancho` para alinear columnas en la tabla de
 * consola. Si `texto` ya es mas largo que `ancho` (segmentos con nombres
 * largos, intervalos anchos), `padEnd` no hace nada y la siguiente columna
 * quedaria pegada sin espacio; por eso aqui se garantiza SIEMPRE al menos un
 * separador de 2 espacios, incluso cuando el contenido desborda el ancho
 * fijado.
 */
function celda(texto: string, ancho: number): string {
  return texto.length >= ancho ? `${texto}  ` : texto.padEnd(ancho);
}

export function formatearReporteConsola(resultado: ResultadoGlobal): string {
  const lineas: string[] = [];
  const linea = '='.repeat(78);
  lineas.push(linea);
  lineas.push('AUDITORIA DE EQUIDAD DEL RECONOCIMIENTO DEL HABLA - Fase 7 / control C5');
  lineas.push(linea);
  lineas.push(`Generado: ${resultado.generadoEn}`);
  lineas.push(`Pares evaluados: ${resultado.totalPares}`);
  lineas.push(`Palabras de referencia (total): ${resultado.totalPalabrasReferencia}`);
  lineas.push(`WER GLOBAL: ${formatearPct(resultado.wer)}`);
  lineas.push('');
  lineas.push('WER por segmento de hablante:');
  lineas.push('-'.repeat(78));
  lineas.push(
    [
      celda('segmento', 18),
      celda('hablantes', 11),
      celda('pares', 7),
      celda('palabras_ref', 14),
      celda('WER', 9),
      celda('IC 95%', 18),
      'muestra',
    ].join(''),
  );
  for (const seg of resultado.segmentos) {
    lineas.push(
      [
        celda(seg.segmento, 18),
        celda(String(seg.numHablantes), 11),
        celda(String(seg.numPares), 7),
        celda(String(seg.totalPalabrasReferencia), 14),
        celda(formatearPct(seg.wer), 9),
        celda(formatearIntervalo(seg.intervalo), 18),
        seg.nivelConfianzaMuestra,
      ].join(''),
    );
  }
  lineas.push('-'.repeat(78));
  lineas.push('');

  if (resultado.brecha) {
    const b = resultado.brecha;
    lineas.push('BRECHA (mejor vs. peor segmento):');
    lineas.push(
      `  Mejor: "${b.mejorSegmento}" con WER ${formatearPct(b.werMejor)}`,
    );
    lineas.push(
      `  Peor:  "${b.peorSegmento}" con WER ${formatearPct(b.werPeor)}`,
    );
    lineas.push(
      `  Brecha absoluta: ${(b.brechaAbsoluta * 100).toFixed(1)} puntos porcentuales ` +
        `(umbral configurado: ${(resultado.umbralBrecha * 100).toFixed(1)})`,
    );
    lineas.push(
      `  Brecha relativa: ${b.brechaRelativa === Infinity ? 'indefinida (mejor segmento en 0%)' : `${b.brechaRelativa.toFixed(2)}x`}`,
    );
    const bloqueaPorBrecha = b.brechaAbsoluta > resultado.umbralBrecha;
    const bloqueaPorMuestra = b.muestraInsuficiente;
    if (bloqueaPorBrecha || bloqueaPorMuestra) {
      lineas.push('');
      lineas.push('*** BLOQUEO DE DESPLIEGUE DE VOZ ***');
      if (bloqueaPorBrecha) {
        lineas.push('  La brecha supera el umbral configurado. Ver docs/fase7-equidad.md.');
      }
      if (bloqueaPorMuestra) {
        lineas.push('  La comparacion se apoya en un segmento con muestra insuficiente.');
      }
    } else {
      lineas.push('');
      lineas.push('Brecha dentro del umbral, con muestra suficiente en ambos extremos.');
    }
  } else {
    lineas.push('BRECHA: no calculable (menos de dos segmentos con WER definido).');
  }

  if (resultado.advertencias.length > 0) {
    lineas.push('');
    lineas.push('ADVERTENCIAS:');
    for (const a of resultado.advertencias) lineas.push(`  - ${a}`);
  }

  lineas.push(linea);
  return lineas.join('\n');
}

export function formatearReporteMarkdown(resultado: ResultadoGlobal): string {
  const lineas: string[] = [];
  lineas.push('## Auditoria de equidad del reconocimiento del habla (Fase 7 / control C5)');
  lineas.push('');
  lineas.push(`Generado: \`${resultado.generadoEn}\``);
  lineas.push('');
  lineas.push(
    `**WER global:** ${formatearPct(resultado.wer)} | **pares evaluados:** ${resultado.totalPares} | ` +
      `**palabras de referencia:** ${resultado.totalPalabrasReferencia}`,
  );
  lineas.push('');
  lineas.push('| Segmento | Hablantes | Pares | Palabras ref. | WER | IC 95% (aprox.) | Muestra |');
  lineas.push('|---|---|---|---|---|---|---|');
  for (const seg of resultado.segmentos) {
    lineas.push(
      `| ${seg.segmento} | ${seg.numHablantes} | ${seg.numPares} | ${seg.totalPalabrasReferencia} | ` +
        `${formatearPct(seg.wer)} | ${formatearIntervalo(seg.intervalo)} | ${seg.nivelConfianzaMuestra} |`,
    );
  }
  lineas.push('');
  if (resultado.brecha) {
    const b = resultado.brecha;
    lineas.push(
      `**Brecha:** "${b.peorSegmento}" (${formatearPct(b.werPeor)}) frente a "${b.mejorSegmento}" ` +
        `(${formatearPct(b.werMejor)}) = **${(b.brechaAbsoluta * 100).toFixed(1)} puntos** ` +
        `(umbral: ${(resultado.umbralBrecha * 100).toFixed(1)} puntos).`,
    );
    const bloquea = b.brechaAbsoluta > resultado.umbralBrecha || b.muestraInsuficiente;
    lineas.push('');
    lineas.push(bloquea ? '**BLOQUEO DE DESPLIEGUE DE VOZ.**' : 'Brecha dentro del umbral.');
  } else {
    lineas.push('**Brecha:** no calculable (menos de dos segmentos con WER definido).');
  }
  if (resultado.advertencias.length > 0) {
    lineas.push('');
    lineas.push('### Advertencias');
    for (const a of resultado.advertencias) lineas.push(`- ${a}`);
  }
  return lineas.join('\n');
}

// --- CLI ---------------------------------------------------------------

interface OpcionesCli {
  input: string;
  outJson?: string;
  outMd?: string;
  umbralBrecha: number;
  minHablantesRecomendado: number;
  minHablantesAbsoluto: number;
}

function obtenerFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

function parseArgsCli(argv: string[]): OpcionesCli {
  const input = obtenerFlag(argv, '--input');
  if (!input) {
    throw new Error(
      'Falta --input <archivo.json> con los pares referencia/hipotesis por segmento de hablante. ' +
        'Ver el encabezado de este script para el formato exacto.',
    );
  }
  return {
    input,
    outJson: obtenerFlag(argv, '--out-json'),
    outMd: obtenerFlag(argv, '--out-md'),
    umbralBrecha: Number(obtenerFlag(argv, '--umbral-brecha') ?? UMBRAL_BRECHA_POR_DEFECTO),
    minHablantesRecomendado: Number(obtenerFlag(argv, '--min-hablantes') ?? UMBRALES_POR_DEFECTO.recomendado),
    minHablantesAbsoluto: Number(obtenerFlag(argv, '--min-absoluto') ?? UMBRALES_POR_DEFECTO.minimoAbsoluto),
  };
}

async function main(): Promise<void> {
  let opciones: OpcionesCli;
  try {
    opciones = parseArgsCli(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  let crudo: string;
  try {
    crudo = await readFile(resolve(process.cwd(), opciones.input), 'utf8');
  } catch {
    console.error(`No se pudo leer el archivo de entrada: ${opciones.input}`);
    process.exitCode = 2;
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (error: unknown) {
    console.error(`El archivo de entrada no es JSON valido: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const validacion = entradaSchema.safeParse(json);
  if (!validacion.success) {
    console.error('El archivo de entrada no cumple el formato esperado:');
    for (const issue of validacion.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exitCode = 2;
    return;
  }

  const umbrales: UmbralesHablantes = {
    minimoAbsoluto: opciones.minHablantesAbsoluto,
    recomendado: opciones.minHablantesRecomendado,
  };

  const resultado = evaluarConjunto(validacion.data, {
    umbrales,
    umbralBrecha: opciones.umbralBrecha,
  });

  console.log(formatearReporteConsola(resultado));

  if (opciones.outJson) {
    await writeFile(resolve(process.cwd(), opciones.outJson), JSON.stringify(resultado, null, 2), 'utf8');
    console.log(`\nJSON escrito en: ${opciones.outJson}`);
  }
  if (opciones.outMd) {
    await writeFile(resolve(process.cwd(), opciones.outMd), formatearReporteMarkdown(resultado), 'utf8');
    console.log(`Markdown escrito en: ${opciones.outMd}`);
  }

  const bloqueaPorBrecha = resultado.brecha !== null && resultado.brecha.brechaAbsoluta > opciones.umbralBrecha;
  const bloqueaPorMuestra = resultado.brecha !== null && resultado.brecha.muestraInsuficiente;
  const bloqueaPorFaltaDeBrecha = resultado.brecha === null;

  process.exitCode = bloqueaPorBrecha || bloqueaPorMuestra || bloqueaPorFaltaDeBrecha ? 1 : 0;
}

const esEntradaPrincipal =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (esEntradaPrincipal) {
  main().catch((error: unknown) => {
    console.error(`wer.ts fallo de forma inesperada: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
