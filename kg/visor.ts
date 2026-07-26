/**
 * GENERADOR del visor grafico.
 *
 * Inyecta `grafo.json` en `visor.plantilla.html` y escribe una pagina
 * autocontenida: sin CDN, sin peticiones de red, sin dependencias. Se abre con
 * doble clic y funciona igual sin conexion.
 *
 * POR QUE UNA PLANTILLA APARTE Y NO UNA CADENA EN ESTE ARCHIVO
 * El visor tiene CSS y JavaScript de verdad. Metido en una plantilla literal de
 * TypeScript habria que escapar cada acento grave y cada `${`, el editor
 * dejaria de colorearlo y cualquier error de escapado se descubriria en el
 * navegador. En un `.html` aparte se edita como lo que es.
 *
 * La salida NO se versiona (`.gitignore`): es una vista derivada de
 * `grafo.json`, que si esta versionado. Regenerarla cuesta un comando, y
 * guardar dos copias del mismo dato garantiza que una de las dos mienta.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RAIZ, RUTA_GRAFO } from './extraer.js';
import type { Grafo } from './ontologia.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RUTA_PLANTILLA = join(AQUI, 'visor.plantilla.html');
export const RUTA_VISOR = join(RAIZ, 'kg', 'grafo.html');

/** Marca que la plantilla deja para recibir los datos. */
const MARCA = '/*__DATOS__*/ null';

const TITULO = 'Recepción-IA · grafo de conocimiento';

export interface OpcionesVisor {
  /**
   * `true` produce un documento HTML completo, para abrir como archivo local.
   * `false` produce solo el contenido del cuerpo, para incrustarlo en un
   * anfitrion que ya aporta `<head>`.
   */
  documentoCompleto?: boolean;
}

export function construirVisor(grafo: Grafo, opciones: OpcionesVisor = {}): string {
  const plantilla = readFileSync(RUTA_PLANTILLA, 'utf8');
  if (!plantilla.includes(MARCA)) {
    throw new Error(`la plantilla no contiene la marca ${MARCA}: no se puede inyectar el grafo`);
  }

  // `</script>` dentro de un literal JSON cerraria la etiqueta que lo contiene,
  // y `<!--` abriria un comentario HTML. Escapar la barra y el guion evita las
  // dos cosas sin alterar el valor que ve `JSON.parse`.
  const datos = JSON.stringify(grafo)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--');

  const cuerpo = plantilla.replace(MARCA, datos);
  if (!opciones.documentoCompleto) return cuerpo;

  return [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${TITULO}</title>`,
    '</head>',
    '<body>',
    cuerpo,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function leerGrafo(ruta: string = RUTA_GRAFO): Grafo {
  return JSON.parse(readFileSync(ruta, 'utf8')) as Grafo;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentos = process.argv.slice(2);
  const fragmento = argumentos.includes('--fragmento');
  const indiceSalida = argumentos.indexOf('--salida');
  const destino = indiceSalida >= 0 && argumentos[indiceSalida + 1] ? argumentos[indiceSalida + 1] : RUTA_VISOR;

  const html = construirVisor(leerGrafo(), { documentoCompleto: !fragmento });
  writeFileSync(destino as string, html, 'utf8');
  process.stdout.write(
    `visor escrito en ${destino}\n  ${(html.length / 1024).toFixed(0)} KB · autocontenido, sin red\n`,
  );
}
