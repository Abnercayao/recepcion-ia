/**
 * INVARIANTES del grafo.
 *
 * La extraccion es lexica, no sintactica (ver la cabecera de `extraer.ts`). Un
 * extractor lexico se degrada en silencio: cambia una convencion de escritura,
 * deja de reconocer algo y produce un grafo mas pequeno que sigue pareciendo
 * valido. Este archivo es lo que convierte esa posibilidad en un fallo ruidoso.
 *
 * Hay dos clases de comprobacion, y conviene no confundirlas:
 *
 *   EXTRACCION — «el grafo describe lo que hay». Si falla, el roto es el
 *   extractor, no el sistema.
 *
 *   ARQUITECTURA — «lo que hay cumple sus propias reglas». Si falla, el roto es
 *   el sistema, y el grafo esta haciendo su trabajo al decirlo.
 */
import { existsSync, readFileSync } from 'node:fs';

import { extraer, serializar, RUTA_GRAFO, RAIZ } from './extraer.js';
import { indexar, violacionesDeCapas, type Indice } from './consultar.js';
import type { Grafo, TipoNodo } from './ontologia.js';

export interface Hallazgo {
  clase: 'extraccion' | 'arquitectura' | 'desfase';
  regla: string;
  detalle: string;
}

/** Minimos que el extractor debe alcanzar. Por debajo, algo dejo de reconocerse. */
const MINIMOS: Array<{ tipo: TipoNodo; minimo: number; porque: string }> = [
  { tipo: 'puerto', minimo: 12, porque: 'el proyecto declara 12 puertos de frontera' },
  { tipo: 'herramienta', minimo: 5, porque: 'son cinco herramientas de negocio, ni una mas' },
  { tipo: 'tabla', minimo: 11, porque: 'las migraciones 001-003 crean 11 tablas' },
  { tipo: 'categoria_adversarial', minimo: 13, porque: 'la bateria tiene 13 categorias' },
  { tipo: 'linea_roja', minimo: 8, porque: '7 prohibiciones absolutas y el protocolo de urgencia' },
  { tipo: 'canal', minimo: 2, porque: 'WhatsApp y voz' },
  { tipo: 'modulo', minimo: 55, porque: 'el codigo fuente no ha encogido a la mitad' },
  { tipo: 'prueba', minimo: 20, porque: 'hay una suite por modulo relevante' },
];

export function verificar(grafo: Grafo): Hallazgo[] {
  const ix = indexar(grafo);
  const hallazgos: Hallazgo[] = [];
  const cuenta = (tipo: TipoNodo): number => grafo.nodos.filter((n) => n.tipo === tipo).length;

  // --- extraccion ----------------------------------------------------------
  for (const { tipo, minimo, porque } of MINIMOS) {
    const encontrados = cuenta(tipo);
    if (encontrados < minimo) {
      hallazgos.push({
        clase: 'extraccion',
        regla: `nodos de tipo "${tipo}"`,
        detalle: `se esperaban >= ${minimo} (${porque}) y hay ${encontrados}`,
      });
    }
  }

  const huerfanos = grafo.nodos.filter(
    (n) => n.tipo === 'modulo' && (ix.salientes.get(n.id) ?? []).length === 0,
  );
  if (huerfanos.length > 0) {
    hallazgos.push({
      clase: 'extraccion',
      regla: 'modulos sin ninguna arista saliente',
      detalle: huerfanos.map((n) => n.ruta ?? n.id).join(', '),
    });
  }

  const sinImplementar = grafo.nodos.filter(
    (n) =>
      n.tipo === 'puerto' &&
      (ix.entrantes.get(n.id) ?? []).every((a) => a.relacion !== 'implementa'),
  );
  if (sinImplementar.length > 0) {
    hallazgos.push({
      clase: 'extraccion',
      regla: 'puertos sin implementacion detectada',
      detalle: `${sinImplementar.map((n) => n.nombre).join(', ')} — o falta el adaptador, o el extractor no lo ve`,
    });
  }

  // --- arquitectura --------------------------------------------------------
  const violaciones = violacionesDeCapas(ix);
  if (violaciones.length > 0) {
    hallazgos.push({
      clase: 'arquitectura',
      regla: 'core/ no importa de channels/ ni de infra/',
      detalle: violaciones.join(' · '),
    });
  }

  const sinControl = grafo.nodos.filter(
    (n) => n.tipo === 'linea_roja' && !n.meta?.['violacion'],
  );
  if (sinControl.length > 0) {
    // NO es un fallo: es el hallazgo que el proyecto ya reconoce — hay lineas
    // rojas que solo viven en el prompt. Se informa, no se rompe.
    hallazgos.push({
      clase: 'arquitectura',
      regla: 'lineas rojas sin control automatico en capa 2',
      detalle: `${sinControl.map((n) => n.nombre).join(' · ')} — solo las vigila el prompt`,
    });
  }

  const tablasSinRls = grafo.nodos.filter(
    (n) => n.tipo === 'tabla' && (ix.entrantes.get(n.id) ?? []).every((a) => a.relacion !== 'protege'),
  );
  if (tablasSinRls.length > 0) {
    hallazgos.push({
      clase: 'arquitectura',
      regla: 'tablas sin politica RLS',
      detalle: tablasSinRls.map((n) => n.nombre).join(', '),
    });
  }

  return hallazgos;
}

/** Compara el grafo en disco con el que sale de las fuentes de ahora mismo. */
export function comprobarDesfase(): Hallazgo | undefined {
  if (!existsSync(RUTA_GRAFO)) {
    return { clase: 'desfase', regla: 'kg/grafo.json', detalle: 'no existe: ejecuta `npm run kg:extraer`' };
  }
  const enDisco = readFileSync(RUTA_GRAFO, 'utf8');
  const recienExtraido = serializar(extraer(RAIZ));
  if (enDisco === recienExtraido) return undefined;
  const anterior = (JSON.parse(enDisco) as Grafo).huella;
  const actual = (JSON.parse(recienExtraido) as Grafo).huella;
  return {
    clase: 'desfase',
    regla: 'kg/grafo.json esta desactualizado',
    detalle: `huella en disco ${anterior}, huella de las fuentes ${actual}: ejecuta \`npm run kg:extraer\``,
  };
}

/** Solo los hallazgos que deben romper una comprobacion automatica. */
export const esBloqueante = (h: Hallazgo): boolean =>
  h.clase === 'desfase' || h.clase === 'extraccion' || h.regla.startsWith('core/');

export function informe(hallazgos: Hallazgo[]): string {
  if (hallazgos.length === 0) return 'grafo verificado: sin hallazgos.';
  return hallazgos
    .map((h) => `${esBloqueante(h) ? '✗' : '·'} [${h.clase}] ${h.regla}\n    ${h.detalle}`)
    .join('\n');
}

export function indiceDelDisco(): Indice {
  return indexar(JSON.parse(readFileSync(RUTA_GRAFO, 'utf8')) as Grafo);
}
