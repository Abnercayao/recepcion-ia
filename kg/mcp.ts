/**
 * SERVIDOR MCP del grafo de conocimiento.
 *
 * Expone el grafo como herramientas para un agente (Claude Code y cualquier
 * otro cliente MCP). Se declara en `.mcp.json`, en la raiz del repositorio, asi
 * que cualquier sesion abierta sobre este proyecto lo tiene disponible sin
 * configuracion previa.
 *
 * POR QUE ESTO Y NO LEER LOS ARCHIVOS
 * Responder «que implementa CalendarPort» leyendo el codigo cuesta abrir varios
 * archivos y gastar contexto en texto que no se va a usar. El grafo lo responde
 * en una linea. La regla practica: el grafo dice DONDE mirar y COMO se conecta
 * todo; el codigo, que sigue siendo la verdad, se lee despues y solo donde hace
 * falta.
 *
 * El grafo se lee de disco en cada llamada. Es un archivo de pocos cientos de
 * kilobytes y asi una re-extraccion se nota de inmediato, sin reiniciar nada.
 */
import { existsSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { RUTA_GRAFO } from './extraer.js';
import {
  alcanzables,
  buscar,
  camino,
  cargar,
  ficha,
  lineaDeNodo,
  panorama,
  resolver,
  trazarControl,
  ubicacion,
  vecinos,
  type Indice,
} from './consultar.js';
import { comprobarDesfase, informe, verificar } from './verificar.js';
import { RELACIONES, TIPOS_NODO } from './ontologia.js';

type Respuesta = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const texto = (t: string): Respuesta => ({ content: [{ type: 'text', text: t }] });
const error = (t: string): Respuesta => ({ content: [{ type: 'text', text: t }], isError: true });

function abrirGrafo(): Indice | undefined {
  return existsSync(RUTA_GRAFO) ? cargar(RUTA_GRAFO) : undefined;
}

/** Envuelve un manejador para que la falta del artefacto sea un mensaje util. */
function conGrafo(manejador: (ix: Indice) => Respuesta): () => Respuesta {
  return () => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    return manejador(ix);
  };
}

const servidor = new McpServer({ name: 'recepcion-ia-kg', version: '1.0.0' });

servidor.registerTool(
  'kg_panorama',
  {
    title: 'Panorama del proyecto',
    description:
      'Mapa general de Recepcion-IA: capas, puertos de frontera y sus implementaciones, las 5 herramientas de negocio, lineas rojas, controles y tablas. Empieza SIEMPRE por aqui al abrir una sesion sobre este proyecto: da la orientacion completa en una sola llamada, sin abrir un solo archivo.',
    inputSchema: {},
  },
  conGrafo((ix) => texto(panorama(ix))),
);

servidor.registerTool(
  'kg_buscar',
  {
    title: 'Buscar en el grafo',
    description:
      'Busca nodos por nombre, ruta o resumen y devuelve su ubicacion `archivo:linea`. Usalo en lugar de rastrear el arbol de archivos cuando sepas COMO se llama algo pero no DONDE esta.',
    inputSchema: {
      termino: z.string().min(1).describe('Texto a buscar: «guardrail», «cita», «RLS», «voz»…'),
      tipo: z
        .enum(TIPOS_NODO)
        .optional()
        .describe('Restringe a un tipo de nodo. Sin esto busca en todos.'),
      limite: z.number().int().min(1).max(100).optional().describe('Maximo de resultados (20 por defecto).'),
    },
  },
  ({ termino, tipo, limite }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const encontrados = buscar(ix, termino, {
      ...(tipo ? { tipo } : {}),
      ...(limite ? { limite } : {}),
    });
    if (encontrados.length === 0) return texto(`Sin coincidencias para "${termino}".`);
    return texto(encontrados.map(lineaDeNodo).join('\n'));
  },
);

servidor.registerTool(
  'kg_ver',
  {
    title: 'Ficha de un nodo',
    description:
      'Ficha completa de un nodo: que es, donde vive, sus metadatos y TODAS sus relaciones en ambos sentidos. Es la respuesta a «que es X y con que se conecta». Acepta el id exacto o un nombre aproximado.',
    inputSchema: {
      nodo: z.string().min(1).describe('Id exacto («puerto:CalendarPort») o nombre aproximado («crear_cita»).'),
    },
  },
  ({ nodo: referencia }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const nodo = resolver(ix, referencia);
    if (!nodo) return texto(`Sin coincidencias para "${referencia}".`);
    return texto(ficha(ix, nodo));
  },
);

servidor.registerTool(
  'kg_vecinos',
  {
    title: 'Relaciones de un nodo',
    description:
      'Vecinos de un nodo, filtrables por relacion y direccion. Responde preguntas como «quien implementa este puerto» (relacion=implementa, direccion=entrantes) o «que modulos escriben en esta tabla» (relacion=usa_tabla, direccion=entrantes).',
    inputSchema: {
      nodo: z.string().min(1).describe('Id exacto o nombre aproximado.'),
      relacion: z.enum(RELACIONES).optional().describe('Filtra por tipo de relacion.'),
      direccion: z
        .enum(['salientes', 'entrantes', 'ambas'])
        .optional()
        .describe('«salientes» = lo que el nodo hace; «entrantes» = quien depende de el.'),
    },
  },
  ({ nodo: referencia, relacion, direccion }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const nodo = resolver(ix, referencia);
    if (!nodo) return texto(`Sin coincidencias para "${referencia}".`);
    const lista = vecinos(ix, nodo.id, {
      ...(relacion ? { relacion } : {}),
      ...(direccion ? { direccion } : {}),
    });
    if (lista.length === 0) return texto(`${nodo.nombre} no tiene vecinos con ese filtro.`);
    return texto(
      `${nodo.nombre}\n` +
        lista
          .map(
            (v) =>
              `${v.direccion === 'sale' ? '→' : '←'} ${v.arista.relacion.padEnd(16)} ${v.nodo.nombre}` +
              `${v.nodo.ruta ? ` · ${ubicacion(v.nodo)}` : ''}`,
          )
          .join('\n'),
    );
  },
);

servidor.registerTool(
  'kg_camino',
  {
    title: 'Camino entre dos nodos',
    description:
      'Camino mas corto entre dos elementos, ignorando la direccion de las aristas. Responde «que tiene que ver esto con aquello»: por ejemplo, como se conecta el webhook de WhatsApp con la tabla de citas.',
    inputSchema: {
      origen: z.string().min(1).describe('Id exacto o nombre aproximado.'),
      destino: z.string().min(1).describe('Id exacto o nombre aproximado.'),
    },
  },
  ({ origen: origenRef, destino: destinoRef }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const origen = resolver(ix, origenRef);
    const destino = resolver(ix, destinoRef);
    if (!origen || !destino) return texto('No encuentro alguno de los dos extremos.');
    const ruta = camino(ix, origen.id, destino.id);
    if (!ruta) return texto(`No hay camino entre ${origen.nombre} y ${destino.nombre}.`);
    return texto(
      ruta
        .map((paso) =>
          'relacion' in paso
            ? `    ${paso.relacion} →`
            : `  ${paso.nombre} [${paso.tipo}]${paso.ruta ? ` · ${ubicacion(paso)}` : ''}`,
        )
        .join('\n'),
    );
  },
);

servidor.registerTool(
  'kg_dependencias',
  {
    title: 'Cierre de dependencias',
    description:
      'Todo lo que un modulo arrastra por importacion, en varios niveles. Sirve para medir el alcance real de un cambio antes de hacerlo.',
    inputSchema: {
      nodo: z.string().min(1).describe('Modulo de partida: ruta o nombre de archivo.'),
      profundidad: z.number().int().min(1).max(6).optional().describe('Niveles a seguir (4 por defecto).'),
    },
  },
  ({ nodo: referencia, profundidad }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const nodo = resolver(ix, referencia);
    if (!nodo) return texto(`Sin coincidencias para "${referencia}".`);
    const lista = alcanzables(ix, nodo.id, 'importa', profundidad ?? 4);
    if (lista.length === 0) return texto(`${nodo.nombre} no importa nada del propio proyecto.`);
    return texto(
      lista
        .sort((a, b) => a.profundidad - b.profundidad || a.nodo.id.localeCompare(b.nodo.id))
        .map(({ nodo: n, profundidad: p }) => `${'  '.repeat(p)}${n.ruta ?? n.nombre}`)
        .join('\n'),
    );
  },
);

servidor.registerTool(
  'kg_control',
  {
    title: 'Trazar un control',
    description:
      'Traza un control del informe etico-regulatorio (C1..C14), operativo (O1..O9) o un riesgo (R1..R5): que significa, en que archivos se toca y que pruebas lo referencian. OJO: en `tests/adversarial/bateria.test.ts` los codigos C1..C13 son las CATEGORIAS de la bateria, que son otra numeracion distinta — para esas, usa kg_buscar con tipo=categoria_adversarial.',
    inputSchema: { codigo: z.string().min(2).describe('Codigo del control: C9, O5, R3…') },
  },
  ({ codigo }) => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    return texto(trazarControl(ix, codigo));
  },
);

servidor.registerTool(
  'kg_verificar',
  {
    title: 'Verificar el grafo',
    description:
      'Comprueba si el grafo esta al dia con las fuentes y si el codigo cumple sus propias reglas de arquitectura (core/ no importa de channels/ ni de infra/, tablas con RLS, lineas rojas con control en capa 2). Usalo despues de cambiar codigo.',
    inputSchema: {},
  },
  () => {
    const ix = abrirGrafo();
    if (!ix) return error('kg/grafo.json no existe todavia. Ejecuta `npm run kg:extraer`.');
    const desfase = comprobarDesfase();
    return texto(informe([...(desfase ? [desfase] : []), ...verificar(ix.grafo)]));
  },
);

const transporte = new StdioServerTransport();
await servidor.connect(transporte);
