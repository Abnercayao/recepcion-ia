/**
 * Implementacion de RagPort: recupera fragmentos aprobados y activos de la
 * clinica para responder con informacion de la base, nunca con conocimiento
 * general (v0.4 del prompt, ver informe del proyecto y §3.1.3.C).
 *
 * Decisiones de diseno tomadas en esta rama (no fijadas por la especificacion,
 * documentadas tambien en el informe final):
 *
 * 1. UMBRAL DE SIMILITUD. El razonamiento original —precision antes que
 *    recall, porque recuperar mal con confianza es peor que un "no dispongo
 *    del dato" de mas— sigue siendo correcto. El NUMERO no lo era.
 *
 *    Estaba en 0.75, elegido sin medir porque no habia clave de Voyage. Con
 *    embeddings reales de voyage-3 sobre la base aprobada (39 fragmentos en
 *    espanol, 27-07-2026), la consulta «¿cuanto cuesta una limpieza dental?»
 *    da esta distribucion:
 *
 *      0.7316  «Profilaxis y limpieza dental: S/ 90 a S/ 150»  <- LA respuesta
 *      0.6025  tratamientos que se ofrecen
 *      0.5727  ortodoncia invisible, rango de referencia
 *      0.5420  los importes son rangos, no precios finales
 *      0.5412  cuanto cuesta un implante
 *      ...     cola larga hasta 0.1730
 *
 *    Con 0.75 pasan CERO fragmentos: ni siquiera el que responde la pregunta
 *    literalmente. El umbral no priorizaba la precision, apagaba el RAG
 *    entero. A 0.50 pasan 5, y los cinco son del tema; a 0.40 pasan 15 y ya
 *    entra ruido. De ahi el 0.50.
 *
 *    ESTO ES UNA CALIBRACION DE UN SOLO PUNTO. Sirve para que el sistema
 *    funcione, no para dar por cerrado el asunto: una calibracion de verdad
 *    necesita un conjunto de consultas de referencia con sus fragmentos
 *    esperados. Por eso el valor se puede cambiar por entorno
 *    (`RAG_UMBRAL_SIMILITUD`) sin tocar codigo.
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
const DEFAULT_UMBRAL_SIMILITUD = 0.5;

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
