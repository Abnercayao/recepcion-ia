/**
 * Implementacion de RagPort: recupera fragmentos aprobados y activos de la
 * clinica para responder con informacion de la base, nunca con conocimiento
 * general (v0.4 del prompt, ver informe del proyecto y §3.1.3.C).
 *
 * Decisiones de diseno tomadas en esta rama (no fijadas por la especificacion,
 * documentadas tambien en el informe final):
 *
 * 1. UMBRAL DE SIMILITUD (0.35, calibrado; antes 0.75 sin calibrar).
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
const DEFAULT_UMBRAL_SIMILITUD = 0.35;

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

    try {
      const [vector] = await this.embeddings.embed([consulta], 'query');
      if (!vector) return [];

      const limiteEfectivo = limit ?? this.limiteFragmentos;
      return await this.repository.matchKnowledge(clinicId, vector, limiteEfectivo, this.umbralSimilitud);
    } catch (err) {
      // Fail-safe deliberado: ver punto 3 del comentario de cabecera.
      this.logger.error(
        {
          clinicId,
          error: err instanceof Error ? err.message : String(err),
        },
        'fallo en recuperacion RAG; se devuelve lista vacia para que el prompt declare que no dispone del dato',
      );
      return [];
    }
  }
}
