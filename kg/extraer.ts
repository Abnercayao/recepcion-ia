/**
 * EXTRACTOR del grafo de conocimiento.
 *
 * Lee las fuentes del repositorio y produce `kg/grafo.json`. El grafo es una
 * FUNCION PURA de las fuentes: misma entrada, misma salida byte a byte. De ahi
 * que no lleve fecha de generacion — llevarla haria que el archivo cambiara en
 * cada ejecucion y arruinaria la deteccion de desfase (`verificar.ts`).
 *
 * POR QUE NO USA EL COMPILADOR DE TYPESCRIPT
 * TypeScript 7 (7.0.2, la version de este repo) es el port nativo y ya NO
 * expone la API clasica de AST: `ts.createSourceFile` no existe. La extraccion
 * es por tanto lexica, ajustada a las convenciones reales de este codigo
 * (modulos ES con extension `.js` explicita, `export class|interface|...` a
 * principio de linea). Es una limitacion consciente, y por eso existe
 * `verificar.ts`: si la extraccion se degrada, las invariantes fallan en vez de
 * producir un grafo silenciosamente incompleto.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANALES,
  CAPAS,
  FASES,
  LINEAS_ROJAS,
  VERSION_GRAFO,
  clasificarCapa,
  idCanal,
  idCapa,
  idCategoria,
  idControl,
  idFase,
  idHerramienta,
  idLineaRoja,
  idModulo,
  idPolitica,
  idPuerto,
  idSimbolo,
  idTabla,
  idVariable,
  type Arista,
  type Grafo,
  type Nodo,
  type Relacion,
} from './ontologia.js';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Directorios que se recorren. Todo lo demas queda fuera del grafo.
 *
 * `kg/` NO esta en la lista, a proposito: el grafo describe el sistema, no la
 * herramienta que lo describe. Incluirlo ademas envenenaba las definiciones —
 * los comentarios de este mismo archivo citan «control C7» y acababan siendo
 * tomados por la definicion del control.
 */
const DIRECTORIOS = ['src', 'tests', 'scripts', 'db', 'prompts', 'docs', 'n8n'];
const EXTENSIONES = new Set(['.ts', '.sql', '.md', '.json']);
const EXCLUIDOS = new Set(['node_modules', 'dist', 'coverage', '.git', '.vitest', 'tmp']);

const RUTA_PUERTOS = 'src/core/types/ports.ts';
const RUTA_CONFIG = 'src/infra/config.ts';
const RUTA_COMPOSICION = 'src/server.ts';
const RUTA_GUARDRAILS = 'src/core/types/guardrail.ts';
const RUTA_BATERIA = 'tests/adversarial/bateria.test.ts';

/**
 * COLISION DE NUMERACIONES, resuelta aqui.
 *
 * El proyecto usa `C1..C13` con DOS significados distintos: los controles del
 * informe etico-regulatorio y las 13 categorias de la bateria adversarial. No
 * son lo mismo — la categoria C9 es «inyeccion a traves del RAG», el control C9
 * es «aislamiento estricto de datos entre clinicas» — y fundirlos produciria un
 * grafo que miente.
 *
 * Regla: en estos archivos, un codigo suelto es una CATEGORIA. Un control solo
 * cuenta ahi si lleva marcador explicito («control C9»).
 */
const ESPACIO_DE_CATEGORIAS = new Set([RUTA_BATERIA]);

// ---------------------------------------------------------------------------
// Acumulador
// ---------------------------------------------------------------------------

class Constructor {
  private readonly nodos = new Map<string, Nodo>();
  private readonly aristas = new Map<string, Arista>();

  nodo(nodo: Nodo): string {
    const existente = this.nodos.get(nodo.id);
    if (existente) {
      // El primer nodo gana en identidad; los siguientes solo pueden rellenar
      // huecos. Asi un control descubierto en un comentario pobre no pisa el
      // resumen bueno hallado despues, ni al reves segun el orden de lectura.
      if (!existente.resumen && nodo.resumen) existente.resumen = nodo.resumen;
      if (existente.ruta === undefined && nodo.ruta !== undefined) existente.ruta = nodo.ruta;
      if (existente.linea === undefined && nodo.linea !== undefined) existente.linea = nodo.linea;
      if (nodo.meta) existente.meta = { ...nodo.meta, ...existente.meta };
      return existente.id;
    }
    this.nodos.set(nodo.id, { ...nodo });
    return nodo.id;
  }

  arista(desde: string, relacion: Relacion, hacia: string, origen?: string): void {
    if (desde === hacia) return;
    const clave = `${desde}|${relacion}|${hacia}`;
    const existente = this.aristas.get(clave);
    if (existente) {
      if (!existente.origen && origen) existente.origen = origen;
      return;
    }
    this.aristas.set(clave, origen ? { desde, relacion, hacia, origen } : { desde, relacion, hacia });
  }

  tiene(id: string): boolean {
    return this.nodos.has(id);
  }

  /** Descarta aristas que apunten a nodos inexistentes. Un grafo con aristas
   *  colgantes miente sobre lo que hay: mejor perder la arista. */
  finalizar(huella: string): Grafo {
    const nodos = [...this.nodos.values()].sort((a, b) => a.id.localeCompare(b.id));
    const aristas = [...this.aristas.values()]
      .filter((a) => this.nodos.has(a.desde) && this.nodos.has(a.hacia))
      .sort((a, b) =>
        a.desde.localeCompare(b.desde) ||
        a.relacion.localeCompare(b.relacion) ||
        a.hacia.localeCompare(b.hacia),
      );
    return { version: VERSION_GRAFO, huella, generadoPor: 'kg/extraer.ts', nodos, aristas };
  }
}

// ---------------------------------------------------------------------------
// Utilidades lexicas
// ---------------------------------------------------------------------------

function listarArchivos(raiz: string): string[] {
  const encontrados: string[] = [];
  const recorrer = (absoluto: string): void => {
    for (const entrada of readdirSync(absoluto).sort()) {
      if (EXCLUIDOS.has(entrada)) continue;
      const hijo = join(absoluto, entrada);
      if (statSync(hijo).isDirectory()) {
        recorrer(hijo);
        continue;
      }
      const punto = entrada.lastIndexOf('.');
      if (punto < 0 || !EXTENSIONES.has(entrada.slice(punto))) continue;
      encontrados.push(relative(raiz, hijo).split('\\').join('/'));
    }
  };
  for (const dir of DIRECTORIOS) {
    const absoluto = join(raiz, dir);
    try {
      if (statSync(absoluto).isDirectory()) recorrer(absoluto);
    } catch {
      // Un directorio opcional que no existe no es un error: el grafo describe
      // lo que hay, no lo que deberia haber.
    }
  }
  return encontrados.sort();
}

const lineaDe = (contenido: string, indice: number): number =>
  contenido.slice(0, indice).split('\n').length;

/** Primera frase util del comentario de cabecera de un archivo. */
function resumenDeCabecera(contenido: string): string | undefined {
  const bloque = /^\s*\/\*\*([\s\S]*?)\*\//.exec(contenido);
  if (!bloque?.[1]) return undefined;
  const lineas = bloque[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .filter((l) => l.length > 0);
  return lineas[0] ? recortar(lineas[0]) : undefined;
}

/** Comentario JSDoc inmediatamente anterior a una posicion. */
function resumenPrevio(contenido: string, indice: number): string | undefined {
  const antes = contenido.slice(0, indice);
  const cierre = antes.lastIndexOf('*/');
  if (cierre < 0) return undefined;
  // Solo cuenta si entre el cierre del comentario y la declaracion no hay mas
  // que espacio en blanco: si no, el comentario es de otra cosa.
  if (antes.slice(cierre + 2).trim().length > 0) return undefined;
  const apertura = antes.lastIndexOf('/*', cierre);
  if (apertura < 0) return undefined;
  const cuerpo = antes.slice(apertura + 2, cierre);
  const lineas = cuerpo
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('@'));
  return lineas[0] ? recortar(lineas[0]) : undefined;
}

function recortar(texto: string, maximo = 180): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo - 1)}…` : limpio;
}

/** Quita los adornos de comentario (`*`, `//`, `--`, `>`, `#`) de un fragmento. */
function limpiarAdornos(texto: string): string {
  return texto
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\*+|\/\/+|--+|>+|#+)\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mejor definicion disponible para un control, a partir de una de sus
 * menciones. Los controles vienen del informe etico-regulatorio, que no esta en
 * el repositorio: lo unico que hay son las frases con que el codigo los cita.
 *
 * Se prefiere una definicion ENTRECOMILLADA justo despues del codigo — que es
 * como el proyecto los enuncia: `control C9 ("Aislamiento estricto de datos
 * entre clinicas")` — y solo si no la hay se recorta la frase de alrededor.
 */
function definirControl(contenido: string, indice: number, codigo: string): { texto: string; citado: boolean } {
  // (1) Enunciacion entrecomillada pegada al codigo. Se exige que empiece cerca
  // y que tenga cuerpo: asi un literal de codigo suelto («otherOptions», «por si
  // acaso») no se cuela como si fuera la definicion del control.
  const despues = limpiarAdornos(
    contenido.slice(indice + codigo.length, Math.min(contenido.length, indice + codigo.length + 220)),
  );
  const cita = /^.{0,60}?[«"“]([^»"”]{15,180})[»"”]/.exec(despues);
  if (cita?.[1]) return { texto: recortar(cita[1]), citado: true };

  // (2) Si no, la frase que contiene la mencion, ya limpia de adornos.
  const ventana = limpiarAdornos(
    contenido.slice(Math.max(0, indice - 180), Math.min(contenido.length, indice + 180)),
  );
  const frases = ventana.split(/(?<=[.;:])\s+/);
  const conElCodigo = frases.find((f) => new RegExp(`(?<![\\w])${codigo}(?![\\w])`).test(f));
  return { texto: recortar(conElCodigo ?? ventana), citado: false };
}

/**
 * Lee la lista de argumentos de una llamada, empezando en el parentesis de
 * apertura. Cuenta parentesis, corchetes y llaves para no cortar en la coma de
 * un objeto literal anidado.
 */
function leerArgumentos(contenido: string, indiceApertura: number): string {
  let profundidad = 0;
  for (let i = indiceApertura; i < contenido.length; i += 1) {
    const c = contenido[i];
    if (c === '(' || c === '[' || c === '{') profundidad += 1;
    else if (c === ')' || c === ']' || c === '}') {
      profundidad -= 1;
      if (profundidad === 0) return contenido.slice(indiceApertura + 1, i);
    }
  }
  return '';
}

/** Resuelve un especificador ES relativo (`../x/y.js`) a una ruta `.ts` del repo. */
function resolverImport(rutaOrigen: string, especificador: string): string | undefined {
  if (!especificador.startsWith('.')) return undefined;
  const sinExtension = especificador.replace(/\.js$/, '');
  const absoluto = join(dirname(rutaOrigen), sinExtension).split('\\').join('/');
  return `${absoluto}.ts`;
}

// ---------------------------------------------------------------------------
// Expresiones
// ---------------------------------------------------------------------------

const RE_IMPORT_DESDE = /(?:^|\n)\s*import\s+[^;]*?from\s*['"]([^'"]+)['"]/g;
const RE_IMPORT_EFECTO = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const RE_EXPORT = /^export\s+(?:async\s+)?(?:abstract\s+)?(class|interface|type|function|const|enum)\s+([A-Za-z_$][\w$]*)/gm;
const RE_IMPLEMENTS = /^export\s+(?:abstract\s+)?class\s+([\w$]+)[^{]*?\bimplements\s+([^{]+?)\s*\{/gm;
/**
 * Un codigo solo se ACEPTA como control si aparece al menos una vez con
 * marcador explicito («control C7», «riesgo R3») o entre parentesis («(C9)»).
 * Cuidado con `control(?:es)?`: escrito `controles?` exigiria «controle».
 * El `\**` absorbe la negrita de Markdown en «control **O9**».
 */
const RE_CONTROL_MARCADO = /\b(?:control(?:es)?|riesgos?)\s+\**([CORF]\d{1,2})\**/gi;
const RE_CONTROL_PARENTESIS = /\(([CORF]\d{1,2})\)/g;
const RE_TABLA_USADA = /\.from\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/g;
const RE_SQL_TABLA = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gim;
const RE_SQL_POLITICA = /^\s*create\s+policy\s+([a-z_][a-z0-9_]*)\s+on\s+([a-z_][a-z0-9_]*)/gim;
const RE_VARIABLE_CONFIG = /^\s+([A-Z][A-Z0-9_]{2,}):\s*(?:z\.|intFromEnv|booleanFromEnv|csvFromEnv)/gm;
const RE_HERRAMIENTA_NOMBRE = /readonly\s+name\s*=\s*['"]([a-z_]+)['"]/;
const RE_HERRAMIENTA_LIMITE = /readonly\s+maxCallsPerConversation\s*=\s*([A-Za-z_$][\w$]*|\d+)/;
const RE_ASIGNACION_NEW = /(?:const|let)\s+([\w$]+)\s*=\s*new\s+([\w$]+)\s*\(/g;
const RE_NEW = /new\s+([\w$]+)\s*\(/g;
const RE_FASE = /\bfase\s+([0-7])\b/gi;

// ---------------------------------------------------------------------------
// Extraccion
// ---------------------------------------------------------------------------

export function extraer(raiz: string = RAIZ): Grafo {
  const g = new Constructor();
  const archivos = listarArchivos(raiz);
  const contenidos = new Map<string, string>();
  for (const ruta of archivos) contenidos.set(ruta, readFileSync(join(raiz, ruta), 'utf8'));

  sembrarCurados(g);
  const tablas = extraerEsquema(g, contenidos);
  const variables = extraerVariablesEntorno(g, contenidos);
  const puertos = extraerPuertos(g, contenidos);
  const controles = descubrirControles(contenidos);

  for (const [ruta, contenido] of contenidos) {
    const capa = clasificarCapa(ruta);
    const idMod = nodoDeArchivo(g, ruta, contenido);
    if (!idMod) continue;
    if (capa) g.arista(idMod, 'pertenece_a', idCapa(capa.id), ruta);

    extraerMenciones(g, idMod, ruta, contenido, controles);
    extraerFases(g, idMod, ruta, contenido);

    if (ruta.endsWith('.ts')) {
      extraerImports(g, idMod, ruta, contenido, contenidos);
      extraerSimbolos(g, idMod, ruta, contenido, puertos);
      extraerUsoDeTablas(g, idMod, ruta, contenido, tablas);
      extraerUsoDeVariables(g, idMod, ruta, contenido, variables);
      extraerCanal(g, idMod, ruta);
    }
  }

  extraerCategorias(g, contenidos);
  extraerHerramientas(g, contenidos);
  extraerComposicion(g, contenidos);
  enlazarLineasRojas(g, contenidos);

  return g.finalizar(huellaDe(contenidos));
}

function sembrarCurados(g: Constructor): void {
  for (const capa of CAPAS) {
    g.nodo({
      id: idCapa(capa.id),
      tipo: 'capa',
      nombre: capa.nombre,
      resumen: capa.regla,
      meta: { prefijos: capa.prefijos },
    });
  }
  for (const canal of CANALES) {
    g.nodo({ id: idCanal(canal.id), tipo: 'canal', nombre: canal.nombre, resumen: canal.resumen });
  }
  for (const fase of FASES) {
    g.nodo({ id: idFase(fase.id), tipo: 'fase', nombre: fase.nombre, resumen: fase.resumen });
  }
  for (const linea of LINEAS_ROJAS) {
    g.nodo({
      id: idLineaRoja(linea.id),
      tipo: 'linea_roja',
      nombre: linea.nombre,
      meta: linea.violacion ? { violacion: linea.violacion } : { violacion: '' },
    });
  }
}

function nodoDeArchivo(g: Constructor, ruta: string, contenido: string): string | undefined {
  const nombre = basename(ruta);
  const lineas = contenido.split('\n').length;
  const capa = clasificarCapa(ruta);
  const meta: Record<string, string | number> = { lineas };
  if (capa) meta['capa'] = capa.id;

  if (ruta.startsWith('tests/')) {
    const suite = ruta.split('/')[1] ?? 'unit';
    return g.nodo({
      id: idModulo(ruta),
      tipo: 'prueba',
      nombre,
      ruta,
      resumen: resumenDeCabecera(contenido) ?? primerTitulo(contenido),
      meta: { ...meta, suite },
    });
  }
  if (ruta.startsWith('docs/')) {
    return g.nodo({
      id: idModulo(ruta),
      tipo: 'documento',
      nombre,
      ruta,
      resumen: primerTitulo(contenido),
      meta,
    });
  }
  if (ruta.startsWith('prompts/')) {
    return g.nodo({
      id: idModulo(ruta),
      tipo: 'prompt',
      nombre,
      ruta,
      resumen: primerTitulo(contenido),
      meta: { ...meta, bloques: bloquesMarkdown(contenido) },
    });
  }
  if (ruta.startsWith('n8n/')) {
    return g.nodo({
      id: idModulo(ruta),
      tipo: 'flujo',
      nombre,
      ruta,
      resumen: primerTitulo(contenido),
      meta,
    });
  }
  if (ruta.endsWith('.ts')) {
    return g.nodo({
      id: idModulo(ruta),
      tipo: 'modulo',
      nombre,
      ruta,
      resumen: resumenDeCabecera(contenido),
      meta,
    });
  }
  if (ruta.endsWith('.sql') || ruta.startsWith('db/')) {
    return g.nodo({ id: idModulo(ruta), tipo: 'modulo', nombre, ruta, meta });
  }
  return undefined;
}

const primerTitulo = (contenido: string): string | undefined => {
  const titulo = /^#{1,3}\s+(.+)$/m.exec(contenido);
  return titulo?.[1] ? recortar(titulo[1]) : undefined;
};

const bloquesMarkdown = (contenido: string): string[] =>
  [...contenido.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => recortar(m[1] ?? '', 60)).filter(Boolean);

// --- esquema de datos ------------------------------------------------------

function extraerEsquema(g: Constructor, contenidos: Map<string, string>): Set<string> {
  const tablas = new Set<string>();
  for (const [ruta, contenido] of contenidos) {
    if (!ruta.endsWith('.sql')) continue;
    for (const m of contenido.matchAll(RE_SQL_TABLA)) {
      const nombre = m[1];
      if (!nombre) continue;
      tablas.add(nombre);
      g.nodo({
        id: idTabla(nombre),
        tipo: 'tabla',
        nombre,
        ruta,
        linea: lineaDe(contenido, m.index ?? 0),
        meta: { migracion: basename(ruta) },
      });
    }
    for (const m of contenido.matchAll(RE_SQL_POLITICA)) {
      const [, politica, tabla] = m;
      if (!politica || !tabla) continue;
      g.nodo({
        id: idPolitica(politica),
        tipo: 'politica_rls',
        nombre: politica,
        ruta,
        linea: lineaDe(contenido, m.index ?? 0),
      });
      g.arista(idPolitica(politica), 'protege', idTabla(tabla), `${ruta}:${lineaDe(contenido, m.index ?? 0)}`);
    }
  }
  return tablas;
}

function extraerUsoDeTablas(
  g: Constructor,
  idMod: string,
  ruta: string,
  contenido: string,
  tablas: Set<string>,
): void {
  for (const m of contenido.matchAll(RE_TABLA_USADA)) {
    const nombre = m[1];
    if (!nombre || !tablas.has(nombre)) continue;
    g.arista(idMod, 'usa_tabla', idTabla(nombre), `${ruta}:${lineaDe(contenido, m.index ?? 0)}`);
  }
}

// --- variables de entorno --------------------------------------------------

function extraerVariablesEntorno(g: Constructor, contenidos: Map<string, string>): Set<string> {
  const variables = new Set<string>();
  const contenido = contenidos.get(RUTA_CONFIG);
  if (!contenido) return variables;
  for (const m of contenido.matchAll(RE_VARIABLE_CONFIG)) {
    const nombre = m[1];
    if (!nombre) continue;
    variables.add(nombre);
    const indice = m.index ?? 0;
    g.nodo({
      id: idVariable(nombre),
      tipo: 'variable_entorno',
      nombre,
      ruta: RUTA_CONFIG,
      linea: lineaDe(contenido, indice),
      resumen: resumenPrevio(contenido, indice),
      meta: { obligatoria: !/\.optional\(\)|\.default\(/.test(m[0] ?? '') },
    });
  }
  return variables;
}

function extraerUsoDeVariables(
  g: Constructor,
  idMod: string,
  ruta: string,
  contenido: string,
  variables: Set<string>,
): void {
  if (ruta === RUTA_CONFIG) return;
  for (const nombre of variables) {
    const re = new RegExp(`\\b(?:config|process\\.env)\\.${nombre}\\b`);
    const m = re.exec(contenido);
    if (m) g.arista(idMod, 'lee_variable', idVariable(nombre), `${ruta}:${lineaDe(contenido, m.index)}`);
  }
}

// --- puertos ---------------------------------------------------------------

function extraerPuertos(g: Constructor, contenidos: Map<string, string>): Set<string> {
  const puertos = new Set<string>();
  const contenido = contenidos.get(RUTA_PUERTOS);
  if (!contenido) return puertos;
  const idMod = idModulo(RUTA_PUERTOS);
  for (const m of contenido.matchAll(/^export\s+interface\s+([\w$]+)/gm)) {
    const nombre = m[1];
    if (!nombre) continue;
    const indice = m.index ?? 0;
    // Un puerto es una interfaz con metodos. Las interfaces de datos puros
    // (`KnowledgeChunk`, `CalendarSlot`) viven en el mismo archivo pero NO son
    // fronteras: no se implementan, se transportan.
    const cuerpo = contenido.slice(indice, contenido.indexOf('\n}', indice));
    if (!/\w+\s*\([^)]*\)\s*:/.test(cuerpo)) continue;
    puertos.add(nombre);
    g.nodo({
      id: idPuerto(nombre),
      tipo: 'puerto',
      nombre,
      ruta: RUTA_PUERTOS,
      linea: lineaDe(contenido, indice),
      resumen: resumenPrevio(contenido, indice),
      meta: { metodos: [...cuerpo.matchAll(/^\s{2}(\w+)\s*[(<]/gm)].map((x) => x[1] ?? '').filter(Boolean) },
    });
    g.arista(idMod, 'declara_puerto', idPuerto(nombre), `${RUTA_PUERTOS}:${lineaDe(contenido, indice)}`);
  }
  return puertos;
}

// --- modulos: imports, simbolos, canal -------------------------------------

function extraerImports(
  g: Constructor,
  idMod: string,
  ruta: string,
  contenido: string,
  contenidos: Map<string, string>,
): void {
  const externas = new Set<string>();
  for (const re of [RE_IMPORT_DESDE, RE_IMPORT_EFECTO]) {
    re.lastIndex = 0;
    for (const m of contenido.matchAll(re)) {
      const especificador = m[1];
      if (!especificador) continue;
      const destino = resolverImport(ruta, especificador);
      const origen = `${ruta}:${lineaDe(contenido, m.index ?? 0)}`;
      if (!destino) {
        externas.add(especificador);
        continue;
      }
      if (!contenidos.has(destino)) continue;
      g.arista(idMod, 'importa', idModulo(destino), origen);
      if (ruta.startsWith('tests/') && destino.startsWith('src/')) {
        g.arista(idMod, 'verifica', idModulo(destino), origen);
      }
    }
  }
  if (externas.size > 0) {
    g.nodo({ id: idMod, tipo: 'modulo', nombre: basename(ruta), meta: { externas: [...externas].sort() } });
  }
}

function extraerSimbolos(
  g: Constructor,
  idMod: string,
  ruta: string,
  contenido: string,
  puertos: Set<string>,
): void {
  RE_EXPORT.lastIndex = 0;
  for (const m of contenido.matchAll(RE_EXPORT)) {
    const [, clase, nombre] = m;
    if (!clase || !nombre) continue;
    const indice = m.index ?? 0;
    // Un puerto ya tiene nodo propio (`puerto:X`) creado por `extraerPuertos`.
    // Crear ademas `simbolo:.../ports.ts#X` lo duplicaria y partiria en dos las
    // aristas que le llegan: se reusa el identificador existente.
    const esPuerto = ruta === RUTA_PUERTOS && puertos.has(nombre);
    const id = esPuerto ? idPuerto(nombre) : idSimbolo(ruta, nombre);
    if (!esPuerto) {
      g.nodo({
        id,
        tipo: 'simbolo',
        nombre,
        ruta,
        linea: lineaDe(contenido, indice),
        resumen: resumenPrevio(contenido, indice),
        meta: { clase },
      });
    }
    g.arista(idMod, 'exporta', id, `${ruta}:${lineaDe(contenido, indice)}`);
  }

  RE_IMPLEMENTS.lastIndex = 0;
  for (const m of contenido.matchAll(RE_IMPLEMENTS)) {
    const [, clase, listaImplementadas] = m;
    if (!clase || !listaImplementadas) continue;
    const origen = `${ruta}:${lineaDe(contenido, m.index ?? 0)}`;
    for (const bruto of listaImplementadas.split(',')) {
      // `BusinessTool<CrearCitaInput, CrearCitaOutput>` -> `BusinessTool`. La
      // division por comas parte los genericos; quedarse con el nombre base
      // antes del `<` los reconstituye sin necesidad de un parser.
      const nombre = bruto.trim().split('<')[0]?.trim();
      if (!nombre || !/^[\w$]+$/.test(nombre)) continue;
      if (puertos.has(nombre)) {
        g.arista(idSimbolo(ruta, clase), 'implementa', idPuerto(nombre), origen);
      } else {
        g.arista(idSimbolo(ruta, clase), 'implementa', idSimbolo(RUTA_PUERTOS, nombre), origen);
      }
    }
  }
}

function extraerCanal(g: Constructor, idMod: string, ruta: string): void {
  if (ruta.includes('/whatsapp/') || ruta.includes('whatsapp.')) {
    g.arista(idMod, 'sirve_canal', idCanal('whatsapp'), ruta);
  }
  if (ruta.includes('/voice/') || ruta.includes('voice-') || ruta.includes('elevenlabs')) {
    g.arista(idMod, 'sirve_canal', idCanal('voz'), ruta);
  }
}

// --- controles y fases -----------------------------------------------------

const CLASES_DE_CONTROL: Record<string, string> = {
  C: 'etico',
  O: 'operativo',
  R: 'riesgo',
  F: 'fase',
};

/**
 * PRIMER PASE: que codigos son controles de verdad.
 *
 * Solo se aceptan los que aparecen alguna vez con marcador explicito. Sin este
 * filtro, buscar `[CO]\d+` a secas convertiria cualquier «O2» o «C4» suelto de
 * un texto en un control inexistente. Se queda ademas con la frase mas larga
 * que rodea al codigo, que es la mejor definicion disponible: estos controles
 * vienen del informe etico, que no esta en el repositorio.
 */
function descubrirControles(contenidos: Map<string, string>): Map<string, string> {
  const mejor = new Map<string, { texto: string; puntos: number }>();
  const considerar = (codigo: string, ruta: string, contenido: string, indice: number): void => {
    const normalizado = codigo.toUpperCase();
    // `F` marca fases en los nombres de flujo n8n (`F3_recordatorios`), no un
    // control: se descarta para no inventar controles inexistentes.
    if (normalizado.startsWith('F')) return;
    const candidata = definirControl(contenido, indice, normalizado);
    // La enunciacion entrecomillada gana a todo. Despues, la prosa de `docs/`
    // gana al comentario de codigo: el comentario explica una decision local,
    // la documentacion enuncia el control.
    const puntos =
      (candidata.citado ? 1000 : 0) +
      (ruta.endsWith('.md') ? 100 : 0) +
      Math.min(candidata.texto.length, 200) / 10;
    const previa = mejor.get(normalizado);
    if (previa === undefined || puntos > previa.puntos) mejor.set(normalizado, { texto: candidata.texto, puntos });
  };

  for (const [ruta, contenido] of contenidos) {
    for (const re of [RE_CONTROL_MARCADO, RE_CONTROL_PARENTESIS]) {
      re.lastIndex = 0;
      for (const m of contenido.matchAll(re)) {
        if (m[1]) considerar(m[1], ruta, contenido, m.index ?? 0);
      }
    }
  }
  return new Map([...mejor].map(([codigo, d]) => [codigo, d.texto]));
}

/**
 * SEGUNDO PASE: donde aparece cada control ya aceptado.
 *
 * Una vez que el codigo es legitimo, se le busca en todo el repositorio aunque
 * la mencion vaya sin marcador («relevante para C10»). El riesgo de falso
 * positivo desaparecio en el primer pase, asi que aqui conviene ser exhaustivo:
 * el valor de la pregunta «donde se toca C9» esta en no perder ni un sitio.
 */
function extraerMenciones(
  g: Constructor,
  idMod: string,
  ruta: string,
  contenido: string,
  controles: Map<string, string>,
): void {
  // En la bateria adversarial un `C9` suelto es la categoria 9, no el control 9.
  // Alli solo valen las menciones con marcador, que el primer pase ya recogio.
  if (ESPACIO_DE_CATEGORIAS.has(ruta)) return;
  for (const [codigo, definicion] of controles) {
    const re = new RegExp(`(?<![\\w])${codigo}(?![\\w])`, 'g');
    let primera: RegExpExecArray | null = null;
    const origenes: string[] = [];
    for (const m of contenido.matchAll(re)) {
      primera ??= m as RegExpExecArray;
      origenes.push(`${ruta}:${lineaDe(contenido, m.index ?? 0)}`);
    }
    if (!primera) continue;

    const inicial = codigo[0] ?? '';
    g.nodo({
      id: idControl(codigo),
      tipo: 'control',
      nombre: codigo,
      resumen: definicion,
      meta: {
        clase: CLASES_DE_CONTROL[inicial] ?? 'desconocida',
        // El enunciado autoritativo vive en el informe etico-regulatorio, que
        // NO esta en el repositorio. Lo de aqui se reconstruye de como lo citan
        // el codigo y la documentacion: sirve para orientarse, no para auditar.
        definicionInferida: true,
      },
    });
    const origen = origenes[0] ?? ruta;
    g.arista(idMod, 'menciona', idControl(codigo), origen);
    if (ruta.startsWith('tests/')) g.arista(idMod, 'verifica', idControl(codigo), origen);
  }
}

function extraerFases(g: Constructor, idMod: string, ruta: string, contenido: string): void {
  const porNombre = /^n8n\/F([0-9])_/.exec(ruta) ?? /(?:^|\/)fase([0-7])/.exec(ruta);
  if (porNombre?.[1]) g.arista(idMod, 'cubre_fase', idFase(porNombre[1]), ruta);
  if (!ruta.startsWith('docs/') && !ruta.startsWith('tests/')) return;
  RE_FASE.lastIndex = 0;
  for (const m of contenido.matchAll(RE_FASE)) {
    if (m[1]) g.arista(idMod, 'cubre_fase', idFase(m[1]), `${ruta}:${lineaDe(contenido, m.index ?? 0)}`);
  }
}

// --- categorias de la bateria adversarial ---------------------------------

/**
 * Las 13 categorias de la bateria. Se leen de los encabezados `C7 — titulo`
 * que abren cada bloque `describe`, y se quedan con el titulo mas largo de los
 * varios que aparecen (comentario de seccion, nombre del describe).
 */
function extraerCategorias(g: Constructor, contenidos: Map<string, string>): void {
  for (const ruta of ESPACIO_DE_CATEGORIAS) {
    const contenido = contenidos.get(ruta);
    if (!contenido) continue;
    const titulos = new Map<string, { titulo: string; linea: number }>();
    for (const m of contenido.matchAll(/\bC(\d{1,2})\s*[—–-]\s*([^\n'"`]{3,90})/g)) {
      const [, numero, tituloBruto] = m;
      if (!numero || !tituloBruto) continue;
      const codigo = `C${numero}`;
      const titulo = recortar(tituloBruto.replace(/[',`]\s*,?\s*(\(\)|async).*$/, ''), 90);
      // Gana la PRIMERA aparicion: es el encabezado de seccion, el titulo
      // canonico. Las siguientes son nombres de casos concretos dentro de la
      // categoria y describen el caso, no la categoria.
      if (!titulos.has(codigo)) titulos.set(codigo, { titulo, linea: lineaDe(contenido, m.index ?? 0) });
    }
    for (const [codigo, { titulo, linea }] of titulos) {
      g.nodo({
        id: idCategoria(codigo),
        tipo: 'categoria_adversarial',
        nombre: `${codigo} — ${titulo}`,
        ruta,
        linea,
        resumen: titulo,
      });
      g.arista(idModulo(ruta), 'cubre_categoria', idCategoria(codigo), `${ruta}:${linea}`);
    }
  }
}

// --- herramientas de negocio ----------------------------------------------

function extraerHerramientas(g: Constructor, contenidos: Map<string, string>): void {
  for (const [ruta, contenido] of contenidos) {
    if (!ruta.startsWith('src/core/tools/') || !ruta.endsWith('.tool.ts')) continue;
    const nombre = RE_HERRAMIENTA_NOMBRE.exec(contenido)?.[1];
    if (!nombre) continue;
    const clase = /export\s+class\s+([\w$]+)/.exec(contenido)?.[1];
    const limiteBruto = RE_HERRAMIENTA_LIMITE.exec(contenido)?.[1] ?? '';
    // El limite suele declararse como constante con nombre; se resuelve a su
    // valor literal para que el grafo diga un numero y no un identificador.
    const limite = /^\d+$/.test(limiteBruto)
      ? Number(limiteBruto)
      : Number(new RegExp(`${limiteBruto}\\s*=\\s*(\\d+)`).exec(contenido)?.[1] ?? Number.NaN);
    const descripcion = /readonly\s+description\s*=\s*\n?\s*['"`]([\s\S]{0,200}?)['"`]/.exec(contenido)?.[1];

    const meta: Record<string, string | number> = {};
    if (clase) meta['clase'] = clase;
    if (Number.isFinite(limite)) meta['maxLlamadasPorConversacion'] = limite;

    const id = g.nodo({
      id: idHerramienta(nombre),
      tipo: 'herramienta',
      nombre,
      ruta,
      linea: lineaDe(contenido, contenido.indexOf('export class')),
      resumen: descripcion ? recortar(descripcion) : resumenDeCabecera(contenido),
      meta,
    });
    g.arista(idModulo(ruta), 'exporta', id, ruta);
    g.arista(idModulo('src/core/tools/tool.registry.ts'), 'registra', id, 'src/server.ts');
    if (clase) g.arista(idSimbolo(ruta, clase), 'implementa', idHerramienta(nombre), ruta);
  }
}

// --- raiz de composicion ---------------------------------------------------

/**
 * Reconstruye el cableado de `server.ts`: que recibe cada pieza por
 * constructor. Es la unica forma de saber que `ConversationServiceImpl` depende
 * de `GuardrailService` sin ejecutar el programa, porque el nucleo solo declara
 * puertos.
 */
function extraerComposicion(g: Constructor, contenidos: Map<string, string>): void {
  const contenido = contenidos.get(RUTA_COMPOSICION);
  if (!contenido) return;

  const claseDeVariable = new Map<string, string>();
  RE_ASIGNACION_NEW.lastIndex = 0;
  for (const m of contenido.matchAll(RE_ASIGNACION_NEW)) {
    if (m[1] && m[2]) claseDeVariable.set(m[1], m[2]);
  }

  const rutaDeClase = new Map<string, string>();
  for (const [ruta, texto] of contenidos) {
    if (!ruta.startsWith('src/') || !ruta.endsWith('.ts')) continue;
    for (const m of texto.matchAll(/^export\s+(?:abstract\s+)?class\s+([\w$]+)/gm)) {
      if (m[1] && !rutaDeClase.has(m[1])) rutaDeClase.set(m[1], ruta);
    }
  }
  const idDeClase = (clase: string): string | undefined => {
    const ruta = rutaDeClase.get(clase);
    return ruta ? idSimbolo(ruta, clase) : undefined;
  };

  RE_NEW.lastIndex = 0;
  for (const m of contenido.matchAll(RE_NEW)) {
    const clase = m[1];
    const apertura = (m.index ?? 0) + m[0].length - 1;
    if (!clase) continue;
    const consumidor = idDeClase(clase);
    if (!consumidor) continue;
    const argumentos = leerArgumentos(contenido, apertura);
    const origen = `${RUTA_COMPOSICION}:${lineaDe(contenido, m.index ?? 0)}`;
    for (const identificador of new Set(argumentos.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const claseArgumento = claseDeVariable.get(identificador);
      if (!claseArgumento) continue;
      const proveedor = idDeClase(claseArgumento);
      if (proveedor) g.arista(consumidor, 'inyecta', proveedor, origen);
    }
  }
}

// --- lineas rojas ----------------------------------------------------------

/**
 * Ata cada linea roja al identificador de violacion que la vigila en la capa 2.
 * Si `guardrail.ts` deja de declarar una violacion, la arista desaparece y la
 * linea roja queda visiblemente sin control: es el hallazgo, no un fallo.
 */
function enlazarLineasRojas(g: Constructor, contenidos: Map<string, string>): void {
  const guardrails = contenidos.get(RUTA_GUARDRAILS) ?? '';
  const declaradas = new Set(
    [...guardrails.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '').filter(Boolean),
  );
  const idCapaDos = idSimbolo('src/core/claude/guardrails.ts', 'GuardrailService');

  for (const linea of LINEAS_ROJAS) {
    if (!linea.violacion || !declaradas.has(linea.violacion)) continue;
    if (!g.tiene(idCapaDos)) continue;
    g.arista(idCapaDos, 'aplica', idLineaRoja(linea.id), RUTA_GUARDRAILS);
  }

  // El prompt maestro enuncia TODAS las lineas rojas; el que las enuncie no
  // significa que exista control detras, y esa distincion es el punto.
  const idPromptMaestro = idModulo('prompts/maestro.md');
  if (!g.tiene(idPromptMaestro)) return;
  for (const linea of LINEAS_ROJAS) {
    g.arista(idPromptMaestro, 'aplica', idLineaRoja(linea.id), 'prompts/maestro.md');
  }
}

// --- huella ----------------------------------------------------------------

function huellaDe(contenidos: Map<string, string>): string {
  const resumen = createHash('sha256');
  for (const ruta of [...contenidos.keys()].sort()) {
    resumen.update(ruta);
    resumen.update(createHash('sha256').update(contenidos.get(ruta) ?? '').digest('hex'));
  }
  return resumen.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export const RUTA_GRAFO = join(RAIZ, 'kg', 'grafo.json');

export function serializar(grafo: Grafo): string {
  return `${JSON.stringify(grafo, null, 2)}\n`;
}

export function escribir(grafo: Grafo, destino: string = RUTA_GRAFO): void {
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, serializar(grafo), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const grafo = extraer();
  escribir(grafo);
  const porTipo = new Map<string, number>();
  for (const nodo of grafo.nodos) porTipo.set(nodo.tipo, (porTipo.get(nodo.tipo) ?? 0) + 1);
  process.stdout.write(
    `grafo escrito en kg/grafo.json\n` +
      `  ${grafo.nodos.length} nodos · ${grafo.aristas.length} aristas · huella ${grafo.huella}\n` +
      `  ${[...porTipo.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(' · ')}\n`,
  );
}
