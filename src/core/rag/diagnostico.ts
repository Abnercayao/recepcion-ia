/**
 * COMO resolvio el RAG una recuperacion, no solo QUE devolvio.
 *
 * `RagPort.retrieve` devuelve una lista y punto, asi que desde fuera estos
 * cuatro casos son el MISMO array vacio:
 *
 *   · el mensaje era puro saludo y no habia nada que recuperar (normal),
 *   · ningun fragmento supero el umbral de similitud,
 *   · fallo el proveedor de embeddings y respondio el respaldo lexico,
 *   · fallaron los dos y la base no aporto nada.
 *
 * Solo el primero es normal, y los otros tres son la antesala del defecto mas
 * caro del sistema: sin contexto aprobado, el modelo rellena. Distinguirlos es
 * la mitad de poder diagnosticar una respuesta inventada.
 *
 * Vive en un archivo propio y no en `ports.ts` --contrato congelado-- ni en el
 * orquestador: lo declara quien lo produce (el RAG) y lo consume quien
 * instrumenta (el servicio de conversacion), sin que ninguno de los dos tenga
 * que importar del otro.
 */

export interface DiagnosticoDeRag {
  /** `vectorial`, `respaldo_lexico`, `cortesia`, `vacio`, `error`... */
  estrategia: string;
  msEmbedding?: number;
  msConsulta?: number;
  umbral?: number;
  motivo?: string;
}
