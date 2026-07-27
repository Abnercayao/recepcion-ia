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
 *
 * POR QUE EL VEREDICTO ES UN ENUM Y NO UN NUMERO
 * Hubo aqui un `confianza: 0..1` con un umbral de 0.3, y escalaba el 100% de
 * los turnos. El prompt decia que «confianza» era la seguridad de que HAY
 * urgencia; el modelo la leyo como la seguridad de SU CLASIFICACION y respondia
 * `{"urgente": false, "confianza": 0.95}` a «¿cuanto cuesta una limpieza?».
 * Como 0.95 >= 0.3, se escalaba: cuanto mas seguro estaba el modelo de que NO
 * habia urgencia, con mas certeza escalaba el sistema.
 *
 * El defecto no era el umbral —moverlo deja las dos lecturas cabiendo en el
 * mismo campo—, era el campo. Un numero no dice que significa. Un enum si:
 * `sin_urgencia` no se puede confundir con `urgencia` por mucho que el modelo
 * interprete la escala, porque ya no hay escala. Y el sesgo a escalar vive
 * DENTRO de un valor (`no_estoy_seguro`), no en una comparacion posterior que
 * alguien pueda reajustar.
 */
import { z } from 'zod';

import type { ClaudePort, Logger, UrgencyResult } from '../types/index.js';
import { normalizar } from '../claude/guardrails.js';

/**
 * Contrato de salida del clasificador. Cada valor se nombra a si mismo: no hay
 * lectura de esta respuesta bajo la cual la duda produzca silencio.
 *
 *   urgencia         -> escala
 *   no_estoy_seguro  -> escala (aqui vive el sesgo al falso positivo)
 *   sin_urgencia     -> no escala
 */
export const VEREDICTOS = ['urgencia', 'no_estoy_seguro', 'sin_urgencia'] as const;
export type Veredicto = (typeof VEREDICTOS)[number];

export const EsquemaVeredicto = z.object({
  veredicto: z.enum(VEREDICTOS),
  senales: z.array(z.string()),
});

export type RespuestaDelClasificador = z.infer<typeof EsquemaVeredicto>;

/**
 * El MISMO contrato, en JSON Schema, para que lo imponga el servidor.
 *
 * Se escribe a mano en vez de derivarlo de Zod porque las salidas
 * estructuradas exigen una forma concreta —`additionalProperties: false` y
 * `required` completo— y un generador automatico puede dejar de cumplirla en
 * una actualizacion sin que nadie lo note. Que las dos definiciones no se
 * separen lo vigila una prueba unitaria.
 */
export const ESQUEMA_JSON_VEREDICTO: Record<string, unknown> = {
  type: 'object',
  properties: {
    veredicto: {
      type: 'string',
      enum: [...VEREDICTOS],
      description:
        'urgencia si hay cualquier senal de urgencia medica; sin_urgencia solo si es claramente ' +
        'una consulta comercial; no_estoy_seguro ante cualquier duda.',
    },
    senales: {
      type: 'array',
      items: { type: 'string' },
      description: 'Expresiones del mensaje que motivaron el veredicto. Vacio si no hay ninguna.',
    },
  },
  required: ['veredicto', 'senales'],
  additionalProperties: false,
};

/** Un veredicto que no sea `sin_urgencia` escala. La duda escala. */
export const escala = (veredicto: Veredicto): boolean => veredicto !== 'sin_urgencia';

/**
 * `UrgencyResult.confidence` es DESCRIPTIVO: alimenta el log y el motivo del
 * escalamiento, y no entra en ninguna decision. Se deriva del veredicto para
 * que no pueda volver a haber dos fuentes de verdad.
 */
const CONFIANZA_POR_VEREDICTO: Record<Veredicto, number> = {
  urgencia: 0.9,
  no_estoy_seguro: 0.5,
  sin_urgencia: 0,
};

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

/**
 * Extrae y valida el veredicto. Cinturon y tirantes: el esquema del servidor ya
 * garantiza la forma, pero este parser sigue tolerando que venga envuelto en
 * markdown o con texto alrededor porque el puerto `ClaudePort` no promete que
 * toda implementacion sepa imponer esquemas —un doble, otro proveedor, una
 * version antigua del SDK—, y un clasificador que se cae por un cerco de
 * codigo es un clasificador que no sirve.
 *
 * Devuelve `undefined` solo si NO se pudo entender la respuesta. Quien llama
 * decide que hacer con eso, y lo que hace es escalar.
 */
export function parsearRespuesta(texto: string): RespuestaDelClasificador | undefined {
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio === -1 || fin <= inicio) return undefined;
  try {
    const analizado = EsquemaVeredicto.safeParse(JSON.parse(texto.slice(inicio, fin + 1)));
    return analizado.success ? analizado.data : undefined;
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
      const parseada = await this.clasificar(text);

      // El modelo CONTESTO y no se le entiende. Es distinto de que no
      // conteste: con el esquema impuesto por el servidor esto no deberia
      // ocurrir nunca, y si ocurre algo va muy mal. No se cae al modo
      // degradado —que puede decidir «no urgente» por ausencia de lexico—;
      // se escala.
      if (!parseada) {
        this.deps.logger.error(
          { capa: 3, via: 'clasificador' },
          'el clasificador respondio algo que no cumple el contrato; se escala por precaucion',
        );
        return {
          isUrgent: true,
          confidence: 0.5,
          signals: ['veredicto_ininteligible'],
          latencyMs: Date.now() - inicio,
        };
      }

      const isUrgent = escala(parseada.veredicto);
      if (isUrgent) {
        this.deps.logger.warn(
          { capa: 3, via: 'clasificador', veredicto: parseada.veredicto, senales: parseada.senales },
          'urgencia detectada por el clasificador',
        );
      }
      return {
        isUrgent,
        confidence: CONFIANZA_POR_VEREDICTO[parseada.veredicto],
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
   * SOLO el clasificador: sin pre-filtro, sin modo degradado, sin decision.
   *
   * `detectUrgency` es la puerta de produccion y esta bien que lo sea, pero
   * mide dos cosas a la vez: en una urgencia explicita responde el lexico y el
   * modelo no llega ni a hablar. Asi, un clasificador que se degrade queda
   * tapado por el camino rapido justo en los casos mas graves.
   *
   * Esto expone el modelo desnudo para poder calibrarlo
   * (`npm run urgencia:calibrar`). Lanza si el proveedor falla: quien mide
   * quiere enterarse, no recibir un respaldo.
   */
  async clasificar(text: string): Promise<RespuestaDelClasificador | undefined> {
    const respuesta = await this.conTimeout(
      this.deps.claude.complete({
        system: this.deps.prompt,
        messages: [{ role: 'user', content: text }],
        model: this.deps.model,
        maxTokens: 300,
        temperature: 0,
        outputSchema: ESQUEMA_JSON_VEREDICTO,
      }),
    );
    return parsearRespuesta(respuesta.text);
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
