/**
 * CLI del grafo: `npm run kg -- <orden> [argumentos]`.
 *
 * Es el mismo motor que usa el servidor MCP (`consultar.ts`), para que lo que
 * ve una persona y lo que ve un agente no puedan divergir. Existe ademas por
 * una razon practica: si el servidor MCP no esta cargado en una sesion, esto
 * sigue funcionando con un solo comando.
 */
import { existsSync } from 'node:fs';

import { RUTA_GRAFO } from './extraer.js';
import {
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
  alcanzables,
} from './consultar.js';
import { comprobarDesfase, esBloqueante, informe, verificar } from './verificar.js';
import type { Relacion, TipoNodo } from './ontologia.js';

const AYUDA = `grafo de conocimiento de Recepcion-IA

  npm run kg -- panorama                  mapa general del proyecto
  npm run kg -- buscar <termino> [tipo]   busca nodos por nombre, ruta o resumen
  npm run kg -- ver <id|termino>          ficha completa de un nodo y sus vecinos
  npm run kg -- vecinos <id> [relacion]   relaciones de un nodo
  npm run kg -- camino <origen> <destino> como se conectan dos cosas
  npm run kg -- depende <id>              cierre transitivo de importaciones
  npm run kg -- control <C9|O5|R3>        donde se toca un control y quien lo prueba
  npm run kg -- verificar                 invariantes de extraccion y arquitectura

tipos: capa modulo simbolo puerto herramienta control categoria_adversarial
       linea_roja canal tabla politica_rls documento prompt flujo prueba
       variable_entorno fase`;

function salir(texto: string, codigo = 0): never {
  process.stdout.write(`${texto}\n`);
  process.exit(codigo);
}

function main(): void {
  const [orden, ...argumentos] = process.argv.slice(2);
  if (!orden || orden === 'ayuda' || orden === '--help' || orden === '-h') salir(AYUDA);

  if (orden === 'verificar') {
    if (!existsSync(RUTA_GRAFO)) salir('kg/grafo.json no existe: ejecuta `npm run kg:extraer`', 1);
    const desfase = comprobarDesfase();
    const hallazgos = [...(desfase ? [desfase] : []), ...verificar(cargar(RUTA_GRAFO).grafo)];
    salir(informe(hallazgos), hallazgos.some(esBloqueante) ? 1 : 0);
  }

  if (!existsSync(RUTA_GRAFO)) salir('kg/grafo.json no existe: ejecuta `npm run kg:extraer`', 1);
  const ix = cargar(RUTA_GRAFO);

  switch (orden) {
    case 'panorama':
      salir(panorama(ix));
      break;

    case 'buscar': {
      const termino = argumentos[0];
      if (!termino) salir('falta el termino de busqueda', 1);
      const tipo = argumentos[1] as TipoNodo | undefined;
      const encontrados = buscar(ix, termino, tipo ? { tipo } : {});
      if (encontrados.length === 0) salir(`sin coincidencias para "${termino}"`, 1);
      salir(encontrados.map(lineaDeNodo).join('\n'));
      break;
    }

    case 'ver': {
      const referencia = argumentos[0];
      if (!referencia) salir('falta el nodo', 1);
      const nodo = resolver(ix, referencia);
      if (!nodo) salir(`sin coincidencias para "${referencia}"`, 1);
      salir(ficha(ix, nodo));
      break;
    }

    case 'vecinos': {
      const referencia = argumentos[0];
      if (!referencia) salir('falta el nodo', 1);
      const nodo = resolver(ix, referencia);
      if (!nodo) salir(`sin coincidencias para "${referencia}"`, 1);
      const relacion = argumentos[1] as Relacion | undefined;
      const lista = vecinos(ix, nodo.id, relacion ? { relacion } : {});
      if (lista.length === 0) salir(`${nodo.nombre} no tiene vecinos con ese filtro`);
      salir(
        lista
          .map((v) => `${v.direccion === 'sale' ? '→' : '←'} ${v.arista.relacion.padEnd(16)} ${lineaDeNodo(v.nodo)}`)
          .join('\n'),
      );
      break;
    }

    case 'camino': {
      const [origenRef, destinoRef] = argumentos;
      if (!origenRef || !destinoRef) salir('faltan origen y destino', 1);
      const origen = resolver(ix, origenRef);
      const destino = resolver(ix, destinoRef);
      if (!origen || !destino) salir('no encuentro alguno de los dos extremos', 1);
      const ruta = camino(ix, origen.id, destino.id);
      if (!ruta) salir(`no hay camino entre ${origen.nombre} y ${destino.nombre}`, 1);
      salir(
        ruta
          .map((paso) =>
            'relacion' in paso
              ? `    ${paso.relacion} →`
              : `  ${paso.nombre} [${paso.tipo}]${paso.ruta ? ` · ${ubicacion(paso)}` : ''}`,
          )
          .join('\n'),
      );
      break;
    }

    case 'depende': {
      const referencia = argumentos[0];
      if (!referencia) salir('falta el nodo', 1);
      const nodo = resolver(ix, referencia);
      if (!nodo) salir(`sin coincidencias para "${referencia}"`, 1);
      const lista = alcanzables(ix, nodo.id, 'importa', 4);
      if (lista.length === 0) salir(`${nodo.nombre} no importa nada del propio proyecto`);
      salir(
        lista
          .sort((a, b) => a.profundidad - b.profundidad || a.nodo.id.localeCompare(b.nodo.id))
          .map(({ nodo: n, profundidad }) => `${'  '.repeat(profundidad)}${n.ruta ?? n.nombre}`)
          .join('\n'),
      );
      break;
    }

    case 'control':
      if (!argumentos[0]) salir('falta el codigo del control', 1);
      salir(trazarControl(ix, argumentos[0]));
      break;

    default:
      salir(`orden desconocida: ${orden}\n\n${AYUDA}`, 1);
  }
}

main();
