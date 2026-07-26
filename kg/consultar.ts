/**
 * MOTOR DE CONSULTA del grafo.
 *
 * Funciones puras sobre un `Grafo` ya cargado. No sabe de MCP ni de terminal:
 * `cli.ts` y `mcp.ts` son dos envoltorios sobre esto mismo, para que la
 * respuesta que recibe un agente y la que ve una persona no puedan divergir.
 *
 * Todas las salidas son texto compacto pensado para leerse de un vistazo (o
 * para entrar en una ventana de contexto sin gastarla): rutas con numero de
 * linea, sin volcados de codigo.
 */
import { readFileSync } from 'node:fs';

import type { Arista, Grafo, Nodo, Relacion, TipoNodo } from './ontologia.js';

export interface Indice {
  grafo: Grafo;
  porId: Map<string, Nodo>;
  salientes: Map<string, Arista[]>;
  entrantes: Map<string, Arista[]>;
}

export function indexar(grafo: Grafo): Indice {
  const porId = new Map<string, Nodo>();
  const salientes = new Map<string, Arista[]>();
  const entrantes = new Map<string, Arista[]>();
  for (const nodo of grafo.nodos) porId.set(nodo.id, nodo);
  for (const arista of grafo.aristas) {
    if (!salientes.has(arista.desde)) salientes.set(arista.desde, []);
    if (!entrantes.has(arista.hacia)) entrantes.set(arista.hacia, []);
    salientes.get(arista.desde)?.push(arista);
    entrantes.get(arista.hacia)?.push(arista);
  }
  return { grafo, porId, salientes, entrantes };
}

export function cargar(ruta: string): Indice {
  return indexar(JSON.parse(readFileSync(ruta, 'utf8')) as Grafo);
}

// ---------------------------------------------------------------------------
// Busqueda
// ---------------------------------------------------------------------------

/** Puntua la coincidencia de un nodo con un termino. 0 = no casa. */
function puntuar(nodo: Nodo, termino: string): number {
  const t = termino.toLowerCase();
  const nombre = nodo.nombre.toLowerCase();
  const id = nodo.id.toLowerCase();
  const ruta = (nodo.ruta ?? '').toLowerCase();
  const resumen = (nodo.resumen ?? '').toLowerCase();

  if (nombre === t || id === `${nodo.tipo}:${t}`) return 100;
  if (nombre.replace(/[-_.]/g, '') === t.replace(/[-_.]/g, '')) return 90;
  if (nombre.startsWith(t)) return 70;
  if (nombre.includes(t)) return 55;
  if (ruta.includes(t)) return 40;
  if (resumen.includes(t)) return 25;
  return 0;
}

export interface OpcionesBusqueda {
  tipo?: TipoNodo;
  limite?: number;
}

export function buscar(ix: Indice, termino: string, opciones: OpcionesBusqueda = {}): Nodo[] {
  const limite = opciones.limite ?? 20;
  const candidatos: Array<{ nodo: Nodo; puntos: number }> = [];
  for (const nodo of ix.grafo.nodos) {
    if (opciones.tipo && nodo.tipo !== opciones.tipo) continue;
    const puntos = puntuar(nodo, termino);
    if (puntos > 0) candidatos.push({ nodo, puntos });
  }
  return candidatos
    .sort((a, b) => b.puntos - a.puntos || a.nodo.id.localeCompare(b.nodo.id))
    .slice(0, limite)
    .map((c) => c.nodo);
}

/** Resuelve un identificador exacto o, si no existe, la mejor coincidencia. */
export function resolver(ix: Indice, referencia: string): Nodo | undefined {
  return ix.porId.get(referencia) ?? buscar(ix, referencia, { limite: 1 })[0];
}

// ---------------------------------------------------------------------------
// Vecindad
// ---------------------------------------------------------------------------

export interface OpcionesVecinos {
  relacion?: Relacion;
  direccion?: 'salientes' | 'entrantes' | 'ambas';
  limite?: number;
}

export interface Vecino {
  arista: Arista;
  nodo: Nodo;
  direccion: 'sale' | 'entra';
}

export function vecinos(ix: Indice, id: string, opciones: OpcionesVecinos = {}): Vecino[] {
  const direccion = opciones.direccion ?? 'ambas';
  const limite = opciones.limite ?? 100;
  const resultado: Vecino[] = [];

  if (direccion !== 'entrantes') {
    for (const arista of ix.salientes.get(id) ?? []) {
      if (opciones.relacion && arista.relacion !== opciones.relacion) continue;
      const nodo = ix.porId.get(arista.hacia);
      if (nodo) resultado.push({ arista, nodo, direccion: 'sale' });
    }
  }
  if (direccion !== 'salientes') {
    for (const arista of ix.entrantes.get(id) ?? []) {
      if (opciones.relacion && arista.relacion !== opciones.relacion) continue;
      const nodo = ix.porId.get(arista.desde);
      if (nodo) resultado.push({ arista, nodo, direccion: 'entra' });
    }
  }
  return resultado.slice(0, limite);
}

/** Cierre transitivo por una relacion. Util para «que arrastra este modulo». */
export function alcanzables(
  ix: Indice,
  id: string,
  relacion: Relacion,
  profundidadMaxima = 3,
): Array<{ nodo: Nodo; profundidad: number }> {
  const vistos = new Set<string>([id]);
  const salida: Array<{ nodo: Nodo; profundidad: number }> = [];
  let frontera = [id];
  for (let profundidad = 1; profundidad <= profundidadMaxima && frontera.length > 0; profundidad += 1) {
    const siguiente: string[] = [];
    for (const actual of frontera) {
      for (const arista of ix.salientes.get(actual) ?? []) {
        if (arista.relacion !== relacion || vistos.has(arista.hacia)) continue;
        vistos.add(arista.hacia);
        const nodo = ix.porId.get(arista.hacia);
        if (nodo) {
          salida.push({ nodo, profundidad });
          siguiente.push(arista.hacia);
        }
      }
    }
    frontera = siguiente;
  }
  return salida;
}

/** Camino mas corto entre dos nodos, ignorando la direccion de las aristas. */
export function camino(ix: Indice, desde: string, hasta: string): Array<Arista | Nodo> | undefined {
  if (desde === hasta) return ix.porId.has(desde) ? [ix.porId.get(desde) as Nodo] : undefined;
  const previo = new Map<string, { id: string; arista: Arista }>();
  const vistos = new Set([desde]);
  let frontera = [desde];

  while (frontera.length > 0) {
    const siguiente: string[] = [];
    for (const actual of frontera) {
      const adyacentes = [...(ix.salientes.get(actual) ?? []), ...(ix.entrantes.get(actual) ?? [])];
      for (const arista of adyacentes) {
        const otro = arista.desde === actual ? arista.hacia : arista.desde;
        if (vistos.has(otro)) continue;
        vistos.add(otro);
        previo.set(otro, { id: actual, arista });
        if (otro === hasta) {
          const secuencia: Array<Arista | Nodo> = [];
          let cursor = hasta;
          while (cursor !== desde) {
            const paso = previo.get(cursor);
            if (!paso) break;
            const nodo = ix.porId.get(cursor);
            if (nodo) secuencia.unshift(nodo);
            secuencia.unshift(paso.arista);
            cursor = paso.id;
          }
          const inicio = ix.porId.get(desde);
          if (inicio) secuencia.unshift(inicio);
          return secuencia;
        }
        siguiente.push(otro);
      }
    }
    frontera = siguiente;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Presentacion
// ---------------------------------------------------------------------------

export function ubicacion(nodo: Nodo): string {
  if (!nodo.ruta) return '';
  return nodo.linea ? `${nodo.ruta}:${nodo.linea}` : nodo.ruta;
}

export function lineaDeNodo(nodo: Nodo): string {
  const donde = ubicacion(nodo);
  const partes = [`[${nodo.tipo}] ${nodo.nombre}`];
  if (donde) partes.push(`· ${donde}`);
  if (nodo.resumen) partes.push(`\n    ${nodo.resumen}`);
  return partes.join(' ');
}

/** Ficha completa de un nodo: lo que se responde a «que es X». */
export function ficha(ix: Indice, nodo: Nodo): string {
  const lineas: string[] = [];
  lineas.push(`${nodo.nombre}   [${nodo.tipo}]`);
  lineas.push(`id: ${nodo.id}`);
  const donde = ubicacion(nodo);
  if (donde) lineas.push(`en: ${donde}`);
  if (nodo.resumen) lineas.push(`\n${nodo.resumen}`);

  if (nodo.meta && Object.keys(nodo.meta).length > 0) {
    lineas.push('');
    for (const [clave, valor] of Object.entries(nodo.meta)) {
      const texto = Array.isArray(valor) ? valor.join(', ') : String(valor);
      if (texto.length > 0) lineas.push(`  ${clave}: ${texto}`);
    }
  }

  const porRelacion = new Map<string, string[]>();
  for (const v of vecinos(ix, nodo.id)) {
    const flecha = v.direccion === 'sale' ? '→' : '←';
    const clave = `${flecha} ${v.arista.relacion}`;
    if (!porRelacion.has(clave)) porRelacion.set(clave, []);
    porRelacion.get(clave)?.push(`${v.nodo.nombre}${v.nodo.ruta ? ` (${ubicacion(v.nodo)})` : ''}`);
  }
  if (porRelacion.size > 0) {
    lineas.push('');
    for (const [clave, destinos] of [...porRelacion.entries()].sort()) {
      const muestra = destinos.slice(0, 12);
      const resto = destinos.length - muestra.length;
      lineas.push(`  ${clave}: ${muestra.join(', ')}${resto > 0 ? ` … (+${resto})` : ''}`);
    }
  }
  return lineas.join('\n');
}

/** Mapa de orientacion del proyecto. Lo primero que conviene leer. */
export function panorama(ix: Indice): string {
  const { grafo } = ix;
  const contar = (tipo: TipoNodo): Nodo[] => grafo.nodos.filter((n) => n.tipo === tipo);
  const lineas: string[] = [];

  lineas.push('RECEPCION-IA · grafo de conocimiento');
  lineas.push(`${grafo.nodos.length} nodos · ${grafo.aristas.length} aristas · huella ${grafo.huella}`);
  lineas.push('');

  lineas.push('CAPAS');
  for (const capa of contar('capa')) {
    const modulos = vecinos(ix, capa.id, { relacion: 'pertenece_a', direccion: 'entrantes' }).length;
    if (modulos === 0) continue;
    lineas.push(`  ${capa.nombre} (${modulos} archivos) — ${capa.resumen ?? ''}`);
  }

  lineas.push('');
  lineas.push('PUERTOS (fronteras del nucleo)');
  for (const puerto of contar('puerto')) {
    const implementaciones = vecinos(ix, puerto.id, { relacion: 'implementa', direccion: 'entrantes' });
    const nombres = implementaciones.map((i) => i.nodo.nombre).join(', ');
    lineas.push(`  ${puerto.nombre}${nombres ? ` ← ${nombres}` : '  (sin implementacion)'}`);
  }

  lineas.push('');
  lineas.push('HERRAMIENTAS DE NEGOCIO');
  for (const h of contar('herramienta')) {
    const limite = h.meta?.['maxLlamadasPorConversacion'];
    lineas.push(`  ${h.nombre}${limite === undefined ? '' : ` (max ${String(limite)}/conversacion)`} · ${ubicacion(h)}`);
  }

  lineas.push('');
  lineas.push('LINEAS ROJAS');
  for (const linea of contar('linea_roja')) {
    const violacion = String(linea.meta?.['violacion'] ?? '');
    lineas.push(`  ${linea.nombre}${violacion ? ` · capa 2: ${violacion}` : '  ⚠ sin control automatico'}`);
  }

  const controles = contar('control');
  if (controles.length > 0) {
    lineas.push('');
    lineas.push(`CONTROLES REFERENCIADOS (${controles.length})`);
    lineas.push(`  ${controles.map((c) => c.nombre).join(' · ')}`);
  }

  lineas.push('');
  lineas.push('TABLAS');
  lineas.push(`  ${contar('tabla').map((t) => t.nombre).join(' · ')}`);

  return lineas.join('\n');
}

/** Todo lo que toca un control: donde se menciona y que prueba lo verifica. */
export function trazarControl(ix: Indice, codigo: string): string {
  const nodo = ix.porId.get(`control:${codigo.toUpperCase()}`);
  if (!nodo) return `No hay ningun control ${codigo} en el grafo.`;

  const menciones = vecinos(ix, nodo.id, { relacion: 'menciona', direccion: 'entrantes' });
  const verificaciones = vecinos(ix, nodo.id, { relacion: 'verifica', direccion: 'entrantes' });
  const lineas = [`${nodo.nombre} (${String(nodo.meta?.['clase'] ?? '')})`, ''];
  if (nodo.resumen) lineas.push(nodo.resumen, '');

  lineas.push(`Aparece en ${menciones.length} archivo(s):`);
  for (const m of menciones) lineas.push(`  ${m.arista.origen ?? ubicacion(m.nodo)}`);

  lineas.push('');
  if (verificaciones.length === 0) {
    lineas.push('⚠ Ninguna prueba lo referencia por codigo.');
  } else {
    lineas.push('Pruebas que lo referencian:');
    for (const v of verificaciones) lineas.push(`  ${v.arista.origen ?? ubicacion(v.nodo)}`);
  }
  return lineas.join('\n');
}

/**
 * Comprueba la regla de dependencias del proyecto: `core/` no puede importar
 * de `channels/` ni de `infra/`. Devuelve las violaciones encontradas.
 */
export function violacionesDeCapas(ix: Indice): string[] {
  const prohibidas: string[] = [];
  for (const arista of ix.grafo.aristas) {
    if (arista.relacion !== 'importa') continue;
    const desde = ix.porId.get(arista.desde)?.ruta ?? '';
    const hacia = ix.porId.get(arista.hacia)?.ruta ?? '';
    if (!desde.startsWith('src/core/')) continue;
    if (hacia.startsWith('src/channels/') || hacia.startsWith('src/infra/')) {
      prohibidas.push(`${desde} → ${hacia}   (${arista.origen ?? ''})`);
    }
  }
  return prohibidas;
}
