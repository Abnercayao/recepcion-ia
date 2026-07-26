/**
 * Fragmentacion de contenido para la base de conocimiento (spec 3.1.3.B).
 *
 * Criterio de calidad pedido: "fragmentos de una sola idea, con solapamiento
 * suficiente para no cortar el sentido". No se usa libreria: es texto plano,
 * la estrategia es partir por parrafo/seccion (una idea por parrafo, en las
 * fuentes declaradas: formulario, FAQ, guion de urgencias) y, solo cuando un
 * parrafo excede el tamano maximo, partir por oracion con solapamiento.
 *
 * No se hace limpieza semantica (HTML, markdown, etc.): la fuente "web" ya se
 * declara en la especificacion como borrador que requiere sanitizacion y
 * revision humana antes de llegar aqui (3.1.3.A). Este modulo asume texto
 * plano ya saneado.
 */
import type { KnowledgeChunk } from '../types/index.js';

/** Contenido crudo de una fuente, previo a fragmentar. */
export interface ChunkInput {
  contenido: string;
  fuente: KnowledgeChunk['fuente'];
  /** Version de la base a la que pertenece este contenido (trazabilidad, 3.1.3.B). */
  version: number;
}

/**
 * Fragmento resultante. No incluye `id` ni `similarity`: esos los asigna la
 * base de datos y la busqueda respectivamente. `indice` es la posicion dentro
 * del documento origen, util para depurar una recuperacion cuestionada.
 */
export interface Chunk {
  contenido: string;
  fuente: KnowledgeChunk['fuente'];
  version: number;
  indice: number;
}

export interface ChunkerOptions {
  /** Longitud maxima deseada de un fragmento. Por defecto 800: suficiente para una idea completa (p. ej. una entrada de FAQ) sin diluir la recuperacion con varias ideas mezcladas. */
  maxCaracteres?: number;
  /** Cuantos caracteres del final de un fragmento se repiten al inicio del siguiente cuando se fuerza un corte dentro de un parrafo largo. */
  solapamientoCaracteres?: number;
  /** Por debajo de este tamano un fragmento se considera "sin contexto propio" y se fusiona con el siguiente parrafo en vez de quedar solo. */
  minCaracteres?: number;
  /**
   * Un parrafo = un fragmento, sin empaquetado avido.
   *
   * El modo por defecto acumula parrafos hasta `maxCaracteres`, que es correcto
   * en prosa continua (formulario, protocolo de urgencias) donde los parrafos
   * contiguos desarrollan el mismo tema. Es DANINO en contenido ya atomizado
   * como un FAQ: cada par pregunta-respuesta es una idea completa, y empaquetar
   * cinco preguntas sin relacion en un vector diluye la recuperacion — el
   * fragmento recuperado responde a la pregunta equivocada.
   *
   * Medido sobre la clinica de demostracion: 22 preguntas colapsaban en 5
   * fragmentos con el modo por defecto.
   *
   * Los parrafos que excedan `maxCaracteres` se siguen partiendo por oracion.
   */
  unParrafoPorFragmento?: boolean;
}

const DEFAULT_MAX_CARACTERES = 800;
const DEFAULT_SOLAPAMIENTO = 120;
const DEFAULT_MIN_CARACTERES = 120;

/**
 * Fragmenta el contenido de una fuente en fragmentos de una sola idea.
 *
 * Estrategia: cada parrafo (separado por linea en blanco) es candidato a ser
 * un fragmento propio. Los parrafos demasiado cortos se acumulan con el
 * siguiente para no perder contexto; los demasiado largos se parten por
 * oracion con solapamiento para no cortar el sentido a mitad de frase.
 */
export function chunkText(input: ChunkInput, options: ChunkerOptions = {}): Chunk[] {
  const maxCaracteres = options.maxCaracteres ?? DEFAULT_MAX_CARACTERES;
  const solapamiento = options.solapamientoCaracteres ?? DEFAULT_SOLAPAMIENTO;
  const minCaracteres = options.minCaracteres ?? DEFAULT_MIN_CARACTERES;

  const parrafos = input.contenido
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const fragmentos: string[] = [];
  let buffer = '';

  // Modo atomico: cada parrafo es su propio fragmento. Solo se parte lo que
  // excede el maximo; nunca se fusionan dos parrafos.
  if (options.unParrafoPorFragmento === true) {
    for (const parrafo of parrafos) {
      if (parrafo.length > maxCaracteres) {
        fragmentos.push(...partirParrafoLargo(parrafo, maxCaracteres, solapamiento));
      } else {
        fragmentos.push(parrafo);
      }
    }

    return fragmentos.map((contenido, indice) => ({
      contenido,
      fuente: input.fuente,
      version: input.version,
      indice,
    }));
  }

  for (const parrafo of parrafos) {
    const candidato = buffer.length === 0 ? parrafo : `${buffer}\n\n${parrafo}`;
    const bufferDemasiadoBreve = buffer.length > 0 && buffer.length < minCaracteres;

    if (candidato.length <= maxCaracteres || (bufferDemasiadoBreve && parrafo.length <= maxCaracteres)) {
      // Cabe holgadamente, o el buffer previo es demasiado breve para quedar
      // solo (regla de calidad 3.1.3.B: un fragmento breve pierde contexto).
      // En este segundo caso se acepta superar levemente el maximo: es un
      // exceso acotado (buffer < minCaracteres) preferible a un fragmento huerfano.
      buffer = candidato;
      continue;
    }

    // No cabe: se cierra el buffer acumulado antes de seguir, para no perderlo.
    if (buffer.length > 0) {
      fragmentos.push(buffer);
      buffer = '';
    }

    if (parrafo.length > maxCaracteres) {
      fragmentos.push(...partirParrafoLargo(parrafo, maxCaracteres, solapamiento));
    } else {
      buffer = parrafo;
    }
  }

  if (buffer.length > 0) fragmentos.push(buffer);

  return fragmentos.map((contenido, indice) => ({
    contenido,
    fuente: input.fuente,
    version: input.version,
    indice,
  }));
}

/**
 * Parte un parrafo que excede el tamano maximo, respetando limites de
 * oracion (no corta a mitad de frase) y solapando el final de un fragmento
 * con el inicio del siguiente para no perder el sentido en el corte.
 */
function partirParrafoLargo(texto: string, maxCaracteres: number, solapamiento: number): string[] {
  const oraciones = texto.split(/(?<=[.?!])\s+/).filter((o) => o.length > 0);
  const partes: string[] = [];
  let actual = '';

  for (const oracion of oraciones) {
    const candidato = actual.length === 0 ? oracion : `${actual} ${oracion}`;

    if (candidato.length <= maxCaracteres || actual.length === 0) {
      // Se acepta superar el maximo cuando una sola oracion ya lo excede:
      // es preferible un fragmento largo a perder una idea a mitad de frase.
      actual = candidato;
    } else {
      partes.push(actual);
      const cola = colaSolapada(actual, solapamiento);
      actual = cola.length > 0 ? `${cola} ${oracion}` : oracion;
    }
  }

  if (actual.length > 0) partes.push(actual);
  return partes;
}

/** Devuelve el final de `texto` (hasta `n` caracteres) cortando en un limite de palabra, no a mitad de una. */
function colaSolapada(texto: string, n: number): string {
  // OJO: en JavaScript -0 === 0, asi que `texto.slice(-n)` con n = 0 devuelve
  // la cadena ENTERA, no la cadena vacia. Sin esta guarda, pedir solapamiento
  // cero producia el solapamiento maximo: el fragmento anterior completo se
  // duplicaba dentro del siguiente.
  if (n <= 0) return '';
  const cruda = texto.slice(-n);
  const primerEspacio = cruda.indexOf(' ');
  return primerEspacio === -1 ? cruda : cruda.slice(primerEspacio + 1);
}
