/**
 * Implementacion de RagPort: recupera fragmentos aprobados y activos de la
 * clinica para responder con informacion de la base, nunca con conocimiento
 * general (v0.4 del prompt, ver informe del proyecto y §3.1.3.C).
 *
 * Decisiones de diseno tomadas en esta rama (no fijadas por la especificacion,
 * documentadas tambien en el informe final):
 *
 * 1. UMBRAL DE SIMILITUD (0.45 con voyage-3-large; 0.35 con voyage-3; 0.75
 *    antes, sin calibrar).
 *
 *    OJO: el umbral depende del MODELO DE EMBEDDINGS. Comparados los cuatro
 *    disponibles con consultas reales de esta clinica, midiendo el fragmento
 *    correcto frente a uno del mismo dominio pero de otro tema:
 *
 *      modelo            latencia   correcto        incorrecto (max)
 *      voyage-3           2972 ms   0.366 - 0.784   0.280
 *      voyage-3.5-lite     974 ms   0.519 - 0.724   0.340
 *      voyage-3.5         1514 ms   0.517 - 0.803   0.371
 *      voyage-3-large     1100 ms   0.575 - 0.839   0.446
 *
 *    `voyage-3` era el mas lento Y el mas fragil: su peor acierto quedaba en
 *    0.366, a un pelo del umbral de 0.35. `voyage-3-large` sube ese suelo a
 *    0.575 y es 2,7 veces mas rapido, asi que separa mucho mejor.
 *
 *    Con voyage-3-large, 0.45 deja fuera todos los incorrectos medidos (max
 *    0.446) y admite todos los correctos (min 0.575), con holgura por los dos
 *    lados. Si se cambia el modelo hay que volver a medir Y re-embeber la base
 *    entera: consulta y documentos tienen que venir del MISMO modelo o la
 *    similitud no significa nada.
 *
 *    El valor original se eligio a ojo, razonando que en este dominio una
 *    recuperacion equivocada es peor que un "no dispongo del dato" de mas. El
 *    razonamiento sigue siendo bueno; el numero era falso. Medido contra la
 *    base real con voyage-3, el fragmento CORRECTO puntua:
 *
 *      "Trabajan con EPS?"           -> 0.413  (FAQ de EPS)
 *      "Donde queda la sede de X?"   -> 0.713  (FAQ de esa sede)
 *      fragmentos NO relacionados    -> 0.28 a 0.42
 *
 *    Con 0.75 no pasaba NADA: el RAG devolvia lista vacia en todas las
 *    consultas. Y ahi esta el problema, porque el modo de fallo no era el
 *    silencio prudente que se buscaba: sin fragmentos, el modelo rellena. En
 *    la prueba contra el modelo real llego a afirmar que la clinica "solo
 *    cuenta con una sede unica". La linea roja "nunca inventar datos ausentes
 *    de la base" NO tiene control automatico en capa 2 -- solo la vigila el
 *    prompt --, asi que subir el umbral no compraba seguridad: la vendia.
 *
 *    0.35 recupera el fragmento correcto en las consultas medidas. Deja pasar
 *    tambien alguno de tema vecino, y eso es asumible: todo lo que hay en
 *    `knowledge_chunks` es contenido de la clinica ya aprobado, de modo que un
 *    fragmento de mas ensucia el prompt pero no introduce informacion no
 *    autorizada. Un fragmento de MENOS, en cambio, invita a inventar.
 *
 *    Sigue siendo una calibracion sobre pocas consultas: si se cambia el
 *    modelo de embeddings o la base crece mucho, hay que volver a medirlo. El
 *    valor es inyectable por `RagOptions.umbralSimilitud` para poder hacerlo
 *    sin tocar este archivo.
 *
 * 2. NUMERO DE FRAGMENTOS (5 por defecto, igual que el default de
 *    match_knowledge). Suficiente para cubrir una pregunta compuesta
 *    (p. ej. horario + precio de referencia) sin inflar el prompt con
 *    fragmentos redundantes.
 *
 * 3. SIN RESULTADOS -> LISTA VACIA, nunca una excepcion que interrumpa el
 *    turno. Esto cubre tanto "no hay fragmentos por encima del umbral" (caso
 *    normal, lo espera el prompt) como cualquier fallo de infraestructura
 *    (Voyage caido, Supabase caido): se registra como error para
 *    observabilidad, pero de cara al paciente el resultado es el mismo que
 *    "la base no tiene el dato" -- el prompt declara la ausencia y ofrece
 *    escalar, en vez de que la conversacion entera se caiga. La alternativa
 *    (dejar que la excepcion suba) es mas fiel a fallar ruidosamente, pero
 *    un patient-facing turn que revienta por un timeout de un proveedor de
 *    embeddings es un dano mayor que una respuesta conservadora. El costo de
 *    esta decision es que un fallo persistente de RAG es silencioso para el
 *    paciente; se mitiga con el log de error (nivel error, no debug) para que
 *    quede visible en observabilidad/auditoria.
 *
 * 4. SIN RE-RANKING. Anti-patron 13.10 de la especificacion pide
 *    explicitamente "RAG simple" en v1 (nada de frameworks multiagente,
 *    fine-tuning ni Kubernetes). Un re-ranker anadiria una segunda llamada a
 *    otro modelo, latencia (critica en el canal de voz) y una superficie de
 *    fallo mas, para un beneficio marginal cuando la base es chica y los
 *    fragmentos ya son de una sola idea (chunker.ts). Se ordena unicamente
 *    por similitud coseno, tal como hace match_knowledge.
 */
import type { EmbeddingPort, KnowledgeChunk, Logger, RagPort } from '../types/index.js';
import type { KnowledgeRepository } from './knowledge.repository.js';

export interface RagServiceOptions {
  /** Fragmentos a recuperar cuando el llamador no especifica limite explicito. */
  limiteFragmentos?: number;
  /** Similitud coseno minima (0..1) para considerar un fragmento relevante. */
  umbralSimilitud?: number;
}

const DEFAULT_LIMITE_FRAGMENTOS = 5;
const DEFAULT_UMBRAL_SIMILITUD = 0.45;

/**
 * Mensajes de pura cortesia: saludos, despedidas y agradecimientos SIN
 * pregunta. Recuperar para ellos gasta una llamada a Voyage (~1,7 s) sobre un
 * turno que el paciente esta esperando, y no aporta un solo fragmento util.
 *
 * El sesgo esta puesto en NO saltar: solo se omite si el mensaje entero encaja
 * en el patron. Basta con que lleve cualquier otra cosa —una palabra del
 * dominio, un signo de interrogacion, un nombre de sede— para que se recupere
 * con normalidad. Equivocarse saltando cuesta una respuesta sin contexto, que
 * es justo el fallo que hace que el modelo invente; equivocarse recuperando
 * solo cuesta tiempo.
 */
const CORTESIA =
  /^(?:\s*(?:hola|holi|buenas|buen(?:os|as)?(?:\s+(?:dias|tardes|noches))?|que\s+tal|hey|alo|alo\?|gracias|muchas\s+gracias|mil\s+gracias|ok|okey|vale|listo|perfecto|de\s+acuerdo|entendido|adios|chau|hasta\s+luego|nos\s+vemos|buen\s+dia)\s*[.,!¡]*)+$/;

/** True si el mensaje es solo cortesia y no pide ningun dato. */
export function esPuraCortesia(texto: string): boolean {
  const t = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?]/g, '')
    .trim();
  if (t.length === 0 || t.length > 40) return false;
  return CORTESIA.test(t);
}

export class RagService implements RagPort {
  private readonly logger: Logger;
  private readonly limiteFragmentos: number;
  private readonly umbralSimilitud: number;

  constructor(
    private readonly embeddings: EmbeddingPort,
    private readonly repository: KnowledgeRepository,
    logger: Logger,
    options: RagServiceOptions = {},
  ) {
    this.logger = logger.child({ servicio: 'rag' });
    this.limiteFragmentos = options.limiteFragmentos ?? DEFAULT_LIMITE_FRAGMENTOS;
    this.umbralSimilitud = options.umbralSimilitud ?? DEFAULT_UMBRAL_SIMILITUD;
  }

  async retrieve(clinicId: string, query: string, limit?: number): Promise<KnowledgeChunk[]> {
    const consulta = query.trim();
    if (consulta.length === 0) return [];

    // Un saludo no necesita recuperar nada, y recuperarlo cuesta ~1,7 s de
    // llamada a Voyage sobre un turno que el paciente esta esperando.
    if (esPuraCortesia(consulta)) {
      this.logger.debug({ clinicId }, 'consulta de cortesia: se omite la recuperacion');
      return [];
    }

    const limiteEfectivo = limit ?? this.limiteFragmentos;

    try {
      const [vector] = await this.embeddings.embed([consulta], 'query');
      if (vector) {
        const vectorial = await this.repository.matchKnowledge(
          clinicId,
          vector,
          limiteEfectivo,
          this.umbralSimilitud,
        );
        if (vectorial.length > 0) return vectorial;
      }
    } catch (err) {
      // No se devuelve lista vacia todavia: primero se intenta el lexico.
      this.logger.warn(
        { clinicId, error: err instanceof Error ? err.message : String(err) },
        'fallo la busqueda vectorial; se intenta el respaldo lexico',
      );
    }

    return this.respaldoLexico(clinicId, consulta, limiteEfectivo);
  }

  /**
   * Respaldo cuando el vectorial no da nada, sea porque fallo o porque no
   * supero el umbral.
   *
   * Existe por un modo de fallo medido: con el plan gratuito de Voyage (3
   * peticiones por minuto) el embedding devolvia 429 en casi todos los turnos y
   * la recuperacion quedaba vacia. El resultado NO era un "no dispongo del
   * dato" prudente — era el modelo rellenando: llego a decirle a un paciente
   * que la clinica "solo tiene una sede". La linea roja "nunca inventar datos
   * ausentes de la base" no tiene control automatico en capa 2, asi que la
   * unica defensa real es no dejar el prompt sin contexto.
   *
   * Recupera peor que el vectorial y no pretende sustituirlo. Pero devuelve
   * contenido APROBADO de la clinica, que es infinitamente mejor que nada.
   */
  private async respaldoLexico(
    clinicId: string,
    consulta: string,
    limite: number,
  ): Promise<KnowledgeChunk[]> {
    try {
      const lexico = await this.repository.buscarPorPalabras(clinicId, consulta, limite);
      if (lexico.length > 0) {
        this.logger.info(
          { clinicId, fragmentos: lexico.length },
          'recuperacion resuelta por el respaldo lexico',
        );
      }
      return lexico;
    } catch (err) {
      // Aqui si: agotadas las dos vias, lista vacia y el prompt declara la
      // ausencia. Nivel error para que un fallo persistente sea visible.
      this.logger.error(
        { clinicId, error: err instanceof Error ? err.message : String(err) },
        'fallo tambien el respaldo lexico; se devuelve lista vacia',
      );
      return [];
    }
  }
}
