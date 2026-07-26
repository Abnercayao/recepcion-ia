/**
 * Acceso a `knowledge_chunks` (migracion 001) via @supabase/supabase-js.
 *
 * No hay tipos de esquema generados (`Database`) en esta rama, asi que el
 * cliente se usa sin parametrizar: supabase-js resuelve entonces sus
 * genericos como `any` (ver GetRpcFunctionFilterBuilderByArgs en la libreria:
 * "if we are dealing with a non-typed client everything is any"). Por eso
 * TODO dato que entra desde la red se valida con Zod antes de tocar el resto
 * del codigo (regla del contrato: nada de `any` propio, se estrecha con Zod).
 *
 * Aislamiento entre clinicas (control C9, criterio bloqueante absoluto): el
 * UNICO metodo de lectura es `matchKnowledge`, que exige `clinicId` y lo pasa
 * siempre a la funcion SQL `match_knowledge`. Esa funcion filtra por
 * `clinic_id = p_clinic_id AND activo = true` en el propio SQL (migracion
 * 003) y ni siquiera devuelve `clinic_id` en las filas, asi que no existe
 * ruta de codigo en este archivo que pueda leer un fragmento de otra clinica
 * ni uno inactivo.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { KnowledgeChunk } from '../types/index.js';

const fuenteSchema = z.enum(['formulario', 'web', 'faq', 'protocolo_urgencia']);

const matchKnowledgeRowSchema = z.object({
  id: z.string(),
  contenido: z.string(),
  fuente: fuenteSchema,
  similarity: z.number(),
});

const matchKnowledgeRowsSchema = z.array(matchKnowledgeRowSchema);

const idRowSchema = z.object({ id: z.string() });

/** Datos de un fragmento nuevo, previo a la aprobacion (control O2). */
export interface NuevoChunk {
  clinicId: string;
  contenido: string;
  embedding: number[];
  fuente: KnowledgeChunk['fuente'];
  /** Version de la base a la que pertenece (trazabilidad, 3.1.3.B). Por defecto 1, como en el esquema. */
  version?: number;
}

/**
 * Puerto interno del repositorio de conocimiento. No vive en ports.ts porque
 * ese archivo es el contrato compartido entre ramas y este repositorio solo
 * lo consume RagService dentro de esta misma rama (inyeccion por
 * constructor igual, solo que la interfaz es local).
 */
export interface KnowledgeRepository {
  /** Recupera fragmentos activos y aprobados de la clinica via match_knowledge. Aislamiento absoluto (C9). */
  matchKnowledge(
    clinicId: string,
    embedding: number[],
    limit: number,
    minSimilarity: number,
  ): Promise<KnowledgeChunk[]>;
  /** Inserta un fragmento SIN activar (activo=false). Requiere `aprobar` para entrar en produccion (control O2). */
  insertPendiente(chunk: NuevoChunk): Promise<{ id: string }>;
  /** Activa un fragmento tras aprobacion escrita explicita, con fecha y responsable (3.1.3.B, control O2). */
  aprobar(chunkId: string, aprobadoPor: string): Promise<void>;
}

export class SupabaseKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly client: SupabaseClient) {}

  async matchKnowledge(
    clinicId: string,
    embedding: number[],
    limit: number,
    minSimilarity: number,
  ): Promise<KnowledgeChunk[]> {
    const { data, error } = await this.client.rpc('match_knowledge', {
      p_clinic_id: clinicId,
      p_embedding: embedding,
      p_limit: limit,
      p_min_similarity: minSimilarity,
    });

    if (error) {
      throw new Error(`match_knowledge fallo: ${error.message}`);
    }

    const filas = matchKnowledgeRowsSchema.parse(data ?? []);

    return filas.map((fila) => ({
      id: fila.id,
      // clinicId se reafirma desde el parametro de la consulta, nunca desde
      // la fila: la funcion SQL no devuelve clinic_id (no hace falta, ya
      // filtro), asi que no hay dato de otra clinica que pudiera filtrarse.
      clinicId,
      contenido: fila.contenido,
      fuente: fila.fuente,
      similarity: fila.similarity,
    }));
  }

  async insertPendiente(chunk: NuevoChunk): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('knowledge_chunks')
      .insert({
        clinic_id: chunk.clinicId,
        contenido: chunk.contenido,
        embedding: chunk.embedding,
        fuente: chunk.fuente,
        version: chunk.version ?? 1,
        activo: false, // control O2: sin aprobacion escrita no entra en produccion
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`insercion de fragmento pendiente fallo: ${error.message}`);
    }

    return idRowSchema.parse(data);
  }

  async aprobar(chunkId: string, aprobadoPor: string): Promise<void> {
    const { error } = await this.client
      .from('knowledge_chunks')
      .update({
        aprobado_por: aprobadoPor,
        aprobado_en: new Date().toISOString(),
        activo: true,
      })
      .eq('id', chunkId);

    if (error) {
      throw new Error(`aprobacion de fragmento fallo: ${error.message}`);
    }
  }
}
