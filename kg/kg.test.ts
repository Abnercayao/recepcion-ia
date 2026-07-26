/**
 * Pruebas del grafo de conocimiento.
 *
 * VIVEN AQUI Y NO EN `tests/`, a proposito. El extractor recorre `tests/` y
 * recoge de ahi las menciones a controles; un archivo de pruebas que escribe
 * `C9` como dato literal acabaria produciendo una arista «esta prueba verifica
 * el control C9», que es falsa. `kg/` queda fuera del recorrido, asi que las
 * pruebas pueden nombrar los codigos sin ensuciar aquello que miden.
 */
import { describe, expect, it } from 'vitest';

import { extraer, serializar, RAIZ } from './extraer.js';
import { indexar, buscar, camino, resolver, vecinos, violacionesDeCapas } from './consultar.js';
import { comprobarDesfase, esBloqueante, verificar } from './verificar.js';
import { LINEAS_ROJAS, RELACIONES, TIPOS_NODO } from './ontologia.js';

const grafo = extraer(RAIZ);
const ix = indexar(grafo);
const deTipo = (tipo: string) => grafo.nodos.filter((n) => n.tipo === tipo);

describe('extraccion', () => {
  it('es determinista: dos pasadas dan el mismo archivo byte a byte', () => {
    expect(serializar(extraer(RAIZ))).toBe(serializar(extraer(RAIZ)));
  });

  it('no produce aristas colgantes', () => {
    const ids = new Set(grafo.nodos.map((n) => n.id));
    const colgantes = grafo.aristas.filter((a) => !ids.has(a.desde) || !ids.has(a.hacia));
    expect(colgantes).toEqual([]);
  });

  it('solo usa tipos y relaciones del vocabulario declarado', () => {
    const tipos = new Set(TIPOS_NODO as readonly string[]);
    const relaciones = new Set(RELACIONES as readonly string[]);
    expect(grafo.nodos.filter((n) => !tipos.has(n.tipo))).toEqual([]);
    expect(grafo.aristas.filter((a) => !relaciones.has(a.relacion))).toEqual([]);
  });

  it('no se describe a si mismo: kg/ queda fuera del grafo', () => {
    expect(grafo.nodos.filter((n) => n.ruta?.startsWith('kg/'))).toEqual([]);
  });
});

describe('lo que el grafo debe encontrar', () => {
  it('los 12 puertos de frontera, todos en ports.ts', () => {
    const puertos = deTipo('puerto');
    expect(puertos).toHaveLength(12);
    expect(puertos.every((p) => p.ruta === 'src/core/types/ports.ts')).toBe(true);
  });

  it('las 5 herramientas de negocio, con su limite por conversacion', () => {
    const herramientas = deTipo('herramienta');
    expect(herramientas.map((h) => h.nombre).sort()).toEqual([
      'consultar_agenda',
      'consultar_rag',
      'crear_cita',
      'escalar_humano',
      'guardar_lead',
    ]);
    for (const h of herramientas) {
      expect(typeof h.meta?.['maxLlamadasPorConversacion']).toBe('number');
    }
  });

  it('las 13 categorias de la bateria adversarial', () => {
    expect(deTipo('categoria_adversarial')).toHaveLength(13);
  });

  it('las 8 lineas rojas, y dice cuales no tienen control en capa 2', () => {
    expect(deTipo('linea_roja')).toHaveLength(LINEAS_ROJAS.length);
    const sinControl = deTipo('linea_roja').filter((n) => !n.meta?.['violacion']);
    expect(sinControl.map((n) => n.nombre).sort()).toEqual([
      'Ante urgencia medica: interrumpir el flujo comercial y escalar',
      'Nunca inventar datos ausentes de la base',
    ]);
  });

  it('las 11 tablas, todas con al menos una politica RLS', () => {
    const tablas = deTipo('tabla');
    expect(tablas).toHaveLength(11);
    for (const tabla of tablas) {
      const protegen = vecinos(ix, tabla.id, { relacion: 'protege', direccion: 'entrantes' });
      expect(protegen.length, `${tabla.nombre} sin RLS`).toBeGreaterThan(0);
    }
  });

  it('cada puerto tiene al menos una implementacion', () => {
    for (const puerto of deTipo('puerto')) {
      const implementaciones = vecinos(ix, puerto.id, { relacion: 'implementa', direccion: 'entrantes' });
      expect(implementaciones.length, `${puerto.nombre} sin implementacion`).toBeGreaterThan(0);
    }
  });
});

describe('la colision de numeraciones C1..C13', () => {
  it('separa el control C9 de la categoria adversarial C9', () => {
    const control = ix.porId.get('control:C9');
    const categoria = ix.porId.get('categoria_adversarial:C9');
    expect(control).toBeDefined();
    expect(categoria).toBeDefined();
    // El control es aislamiento entre clinicas; la categoria, inyeccion via RAG.
    expect(control?.resumen).not.toBe(categoria?.resumen);
    expect(categoria?.resumen?.toLowerCase()).toContain('inyeccion');
  });

  it('no toma por control un codigo de categoria de la bateria', () => {
    // C1, C2, C11, C12 y C13 SOLO existen como categorias en este repositorio.
    for (const codigo of ['C1', 'C2', 'C11', 'C12', 'C13']) {
      expect(ix.porId.has(`control:${codigo}`), `${codigo} no es un control`).toBe(false);
      expect(ix.porId.has(`categoria_adversarial:${codigo}`)).toBe(true);
    }
  });

  it('la bateria adversarial no genera menciones de control por codigo suelto', () => {
    const desdeBateria = grafo.aristas.filter(
      (a) => a.desde === 'modulo:tests/adversarial/bateria.test.ts' && a.relacion === 'menciona',
    );
    expect(desdeBateria).toEqual([]);
  });
});

describe('reglas de arquitectura', () => {
  it('core/ no importa de channels/ ni de infra/', () => {
    expect(violacionesDeCapas(ix)).toEqual([]);
  });

  it('no hay hallazgos bloqueantes', () => {
    expect(verificar(grafo).filter(esBloqueante)).toEqual([]);
  });
});

describe('el artefacto en disco', () => {
  it('esta al dia con las fuentes', () => {
    // Si esto falla, el codigo cambio y nadie regenero el grafo:
    // `npm run kg:extraer`.
    expect(comprobarDesfase()).toBeUndefined();
  });
});

describe('consultas', () => {
  it('resuelve un nombre aproximado al nodo correcto', () => {
    expect(resolver(ix, 'crear_cita')?.id).toBe('herramienta:crear_cita');
    expect(resolver(ix, 'CalendarPort')?.id).toBe('puerto:CalendarPort');
  });

  it('busca por tipo', () => {
    const resultados = buscar(ix, 'repository', { tipo: 'puerto' });
    expect(resultados.length).toBeGreaterThan(0);
    expect(resultados.every((n) => n.tipo === 'puerto')).toBe(true);
  });

  it('encuentra el camino de un canal a una tabla', () => {
    const ruta = camino(ix, 'modulo:src/channels/whatsapp/whatsapp.controller.ts', 'tabla:conversations');
    expect(ruta).toBeDefined();
    expect(ruta?.length).toBeGreaterThan(2);
  });

  it('devuelve las implementaciones de un puerto', () => {
    const implementaciones = vecinos(ix, 'puerto:CalendarPort', {
      relacion: 'implementa',
      direccion: 'entrantes',
    });
    expect(implementaciones.map((v) => v.nodo.nombre)).toContain('GoogleCalendarClient');
  });
});
