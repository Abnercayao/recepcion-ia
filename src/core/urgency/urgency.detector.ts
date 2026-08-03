/**
 * CAPA 3: clasificador de urgencia.
 *
 * Corre en PARALELO a la generacion, sobre CADA turno, con el modelo rapido.
 * No se delega al prompt principal (especificacion §2): el prompt principal
 * esta optimizado para vender una cita, y un clasificador que comparte
 * objetivo con el flujo comercial acaba clasificando a favor del flujo.
 *
 * El sesgo esta deliberadamente puesto en el falso positivo: derivar de mas es
 * un costo operativo, derivar de menos es un dano (riesgo R3, control C4).
 *
 * Dos caminos, en este orden:
 *   1. Pre-filtro lexico SINCRONO. Las senales inequivocas no esperan al
 *      modelo: si alguien dice que no puede respirar, ya es urgencia. El
 *      presupuesto de tiempo del control C4 es de cinco segundos, y una
 *      llamada al modelo puede agotarlo ella sola.
 *   2. Clasificador con `ClaudePort`. Cubre lo que el lexico no ve.
 */
import type { ClaudePort, Logger, UrgencyResult } from '../types/index.js';
import { normalizar } from '../claude/guardrails.js';

/**
 * Umbral de disparo. Deliberadamente bajo: por encima de 0.3 ya se trata como
 * urgencia. Subirlo es una decision clinica, no una decision de ingenieria.
 */
export const UMBRAL_DE_URGENCIA = 0.3;

/**
 * Senales INEQUIVOCAS. No admiten segunda lectura ni esperan al modelo.
 * La clave es el nombre de la senal que se registra para auditar los falsos
 * positivos (el informe pide poder revisarlos).
 */
const SENALES_INEQUIVOCAS: ReadonlyArray<readonly [string, RegExp]> = [
  ['sangrado_abundante', /\b(no (para|puedo parar|deja) de sangrar|sangra (mucho|un monton|bastante)|sangrado abundante|mucha sangre|boto mucha sangre|no para la sangre|hemorragia)\b/],
  ['dificultad_respiratoria', /\b(no puedo respirar|me falta el aire|me cuesta respirar|me estoy ahogando|me ahogo|dificultad para respirar)\b/],
  ['dificultad_para_tragar', /\b(no puedo tragar|no paso saliva|me cuesta tragar|se me cierra la garganta)\b/],
  ['traumatismo', /\b(traumatismo|me golpearon|un golpe fuerte|me cai y|choque y|accidente|se me (salio|cayo|rompio) (el|un) diente por (un|el) golpe|me rompieron|fractura de (mandibula|maxilar))\b/],
  ['dolor_insoportable', /\b(dolor insoportable|no aguanto el dolor|un dolor que no aguanto|me quiero morir del dolor|el peor dolor|dolor extremo)\b/],
  ['inflamacion_grave', /\b(se me cerro el ojo|tengo la cara deformada|se me hincho toda la cara|hinchazon que crece|el cuello hinchado)\b/],
  ['emergencia_declarada', /\b(es una emergencia|es urgente|urgencia|auxilio|ayuda por favor|necesito atencion ahora)\b/],
];

/**
 * Senales DEBILES. Por si solas no disparan, pero son el criterio de respaldo
 * cuando el modelo no responde: ante un fallo del clasificador con senal debil
 * presente, se escala. Fallar hacia el falso positivo es la politica.
 */
const SENALES_DEBILES: ReadonlyArray<readonly [string, RegExp]> = [
  ['dolor', /\b(me duele|dolor|adolorid)/],
  ['sangrado', /\bsangr/],
  ['inflamacion', /\b(hinchad|inflamad|hinchazon|se me hincho)/],
  ['fiebre', /\b(fiebre|calentura|temperatura alta|escalofrios)\b/],
  ['pus', /\b(pus|absceso|flemon|supura)\b/],
  ['golpe', /\b(golpe|me cai|caida|se me rompio|se me salio)\b/],
];

/** Pre-filtro sincrono. No hace red, no espera a nadie. */
export function prefiltroLexico(text: string): string[] {
  const t = normalizar(text);
  return SENALES_INEQUIVOCAS.filter(([, re]) => re.test(t)).map(([nombre]) => nombre);
}

/** Senales debiles, para el modo degradado. */
export function senalesDebiles(text: string): string[] {
  const t = normalizar(text);
  return SENALES_DEBILES.filter(([, re]) => re.test(t)).map(([nombre]) => nombre);
}

/** Forma del JSON que devuelve el clasificador. */
interface RespuestaDelClasificador {
  urgente: boolean;
  confianza: number;
  senales: string[];
}

/**
 * Extrae el JSON de la respuesta del modelo. Tolera que venga envuelto en
 * markdown o con texto alrededor: el clasificador tiene instruccion de no
 * hacerlo, pero un clasificador que se cae porque el modelo puso un cerco de
 * codigo es un clasificador que no sirve.
 */
export function parsearRespuesta(texto: string): RespuestaDelClasificador | undefined {
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return undefined;
  try {
    const crudo: unknown = JSON.parse(texto.slice(inicio, fin + 1));
    if (typeof crudo !== 'object' || crudo === null) return undefined;
    const obj = crudo as Record<string, unknown>;
    // El campo se llamaba `confianza` y los modelos lo leian como "cuan seguro
    // estoy de mi respuesta", no como "probabilidad de que haya urgencia":
    // devolvian 0.95 junto a `urgente: false`, y la linea 157 lo convertia en
    // urgencia. Todo mensaje escalaba, incluido un saludo. El nombre nuevo
    // lleva la semantica dentro; se sigue aceptando el viejo por compatibilidad.
    const bruto = obj['probabilidad_de_urgencia'] ?? obj['confianza'];
    const confianza = typeof bruto === 'number' ? bruto : 0;
    const senales = Array.isArray(obj['senales'])
      ? obj['senales'].filter((s): s is string => typeof s === 'string')
      : [];
    return {
      urgente: obj['urgente'] === true,
      confianza: Math.min(1, Math.max(0, confianza)),
      senales,
    };
  } catch {
    return undefined;
  }
}

export interface UrgencyDetectorDeps {
  claude: ClaudePort;
  logger: Logger;
  /** Prompt del clasificador. Viene de `prompts/urgencia.clasificador.md`. */
  prompt: string;
  /** Modelo de CLASIFICACION, no el de conversacion. */
  model: string;
  /** Presupuesto de tiempo. Agotado, se responde con el modo degradado. */
  timeoutMs?: number;
}

const TIMEOUT_POR_DEFECTO_MS = 2500;

export class UrgencyDetector {
  constructor(private readonly deps: UrgencyDetectorDeps) {}

  /**
   * CAPA 3. Nunca lanza: un clasificador que rompe el turno es peor que uno
   * que se equivoca, porque deja al paciente sin respuesta.
   */
  async detectUrgency(text: string): Promise<UrgencyResult> {
    const inicio = Date.now();

    // 1. Camino rapido. No espera al modelo.
    const inequivocas = prefiltroLexico(text);
    if (inequivocas.length > 0) {
      this.deps.logger.warn(
        { capa: 3, via: 'prefiltro', senales: inequivocas },
        'urgencia detectada por pre-filtro lexico',
      );
      return {
        isUrgent: true,
        confidence: 1,
        signals: inequivocas,
        latencyMs: Date.now() - inicio,
      };
    }

    // 2. Clasificador.
    try {
      const respuesta = await this.conTimeout(
        this.deps.claude.complete({
          system: this.deps.prompt,
          messages: [{ role: 'user', content: text }],
          model: this.deps.model,
          maxTokens: 200,
          temperature: 0,
        }),
      );
      const parseada = parsearRespuesta(respuesta.text);
      if (!parseada) {
        return this.degradado(text, inicio, 'respuesta_no_parseable');
      }
      const isUrgent = parseada.urgente || parseada.confianza >= UMBRAL_DE_URGENCIA;
      if (isUrgent) {
        this.deps.logger.warn(
          { capa: 3, via: 'clasificador', confianza: parseada.confianza, senales: parseada.senales },
          'urgencia detectada por el clasificador',
        );
      }
      return {
        isUrgent,
        confidence: parseada.confianza,
        signals: parseada.senales,
        latencyMs: Date.now() - inicio,
      };
    } catch (error) {
      this.deps.logger.error(
        { capa: 3, error: error instanceof Error ? error.message : String(error) },
        'fallo el clasificador de urgencia; se pasa a modo degradado',
      );
      return this.degradado(text, inicio, 'fallo_clasificador');
    }
  }

  /**
   * Modo degradado: sin clasificador, decide el lexico debil.
   *
   * Si hay cualquier senal debil se escala. Un paciente que menciona dolor y
   * se queda sin clasificador se deriva a una persona; el costo es una llamada
   * de mas. Si no hay ninguna senal, no se inventa una urgencia, pero el
   * motivo queda registrado para que el fallo sea auditable.
   */
  private degradado(text: string, inicio: number, motivo: string): UrgencyResult {
    const debiles = senalesDebiles(text);
    return {
      isUrgent: debiles.length > 0,
      confidence: debiles.length > 0 ? 0.5 : 0,
      signals: [motivo, ...debiles],
      latencyMs: Date.now() - inicio,
    };
  }

  private async conTimeout<T>(promesa: Promise<T>): Promise<T> {
    const ms = this.deps.timeoutMs ?? TIMEOUT_POR_DEFECTO_MS;
    let temporizador: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promesa,
        new Promise<never>((_, reject) => {
          temporizador = setTimeout(
            () => reject(new Error(`clasificador de urgencia agoto ${ms} ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }
}
