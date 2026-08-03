/**
 * `npm run preparar` y la deteccion de entrada principal.
 *
 * Lo que se prueba aqui es lo que rompe una maquina nueva: un guard de arranque
 * que en Windows no se cumple nunca, y un generador de `.env` que podria
 * pisar lo que alguien escribio a mano.
 */
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  GRUPOS,
  TODAS_LAS_VARIABLES,
  clavesDe,
  completar,
  generarEsqueleto,
  versionDeNodeSuficiente,
} from '../../scripts/preparar.js';

describe('esEntradaPrincipal — el guard que rompia en Windows', () => {
  /**
   * REGRESION. La forma antigua era:
   *
   *   import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
   *
   * En POSIX cuadra de casualidad —la barra inicial de `/home/...` completa el
   * tercer separador—, pero en Windows `C:\...` normalizado da `C:/...` y
   * produce `file://C:/...` con DOS barras, frente a las TRES que genera Node.
   * El resultado no era un error: el proceso terminaba sin hacer nada, y
   * `npm run consola` y `npm start` no arrancaban.
   *
   * No hay Windows donde ejecutar esto, asi que se comprueba sobre las cadenas
   * exactas que produce cada plataforma, que es lo que de verdad falla.
   */
  const formaAntigua = (argv1: string): string => `file://${argv1.replace(/\\/g, '/')}`;

  it('la forma antigua NO cuadra en Windows: dos barras contra tres', () => {
    const argv1 = 'C:\\Users\\abner\\recepcion-ia\\scripts\\consola.ts';
    const real = 'file:///C:/Users/abner/recepcion-ia/scripts/consola.ts';

    expect(formaAntigua(argv1)).toBe('file://C:/Users/abner/recepcion-ia/scripts/consola.ts');
    expect(formaAntigua(argv1)).not.toBe(real);
  });

  it('la forma antigua cuadraba en POSIX, y por eso nadie lo veia', () => {
    const argv1 = '/home/user/recepcion-ia/scripts/consola.ts';
    expect(formaAntigua(argv1)).toBe(pathToFileURL(argv1).href);
  });

  it('`pathToFileURL` cuadra en las dos plataformas', () => {
    // En Windows `pathToFileURL('C:\\...')` da `file:///C:/...`; aqui no se
    // puede ejecutar, pero si se comprueba que la ruta POSIX coincide consigo
    // misma y que la comparacion es la que define Node, no una construida.
    const posix = '/home/user/recepcion-ia/scripts/consola.ts';
    expect(pathToFileURL(posix).href).toBe('file:///home/user/recepcion-ia/scripts/consola.ts');
    expect(pathToFileURL(posix).href.startsWith('file:///')).toBe(true);
  });

  it('ningun modulo del proyecto vuelve a construir la URL a mano', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raiz = join(import.meta.dirname, '..', '..');
    for (const ruta of ['src/server.ts', 'scripts/consola.ts', 'scripts/wer.ts', 'scripts/preparar.ts']) {
      const fuente = await readFile(join(raiz, ruta), 'utf8');
      expect(fuente, `${ruta} construye la URL a mano`).not.toContain('`file://${');
    }
  });
});

describe('versionDeNodeSuficiente', () => {
  it('acepta 20 y superiores, rechaza por debajo', () => {
    for (const v of ['v20.0.0', 'v22.22.2', 'v24.1.0', '20.11.1']) {
      expect(versionDeNodeSuficiente(v), v).toBe(true);
    }
    for (const v of ['v18.20.4', 'v16.0.0', 'v8.17.0']) {
      expect(versionDeNodeSuficiente(v), v).toBe(false);
    }
  });

  it('una version ilegible no se da por buena', () => {
    expect(versionDeNodeSuficiente('vaya')).toBe(false);
  });
});

describe('clavesDe', () => {
  it('distingue puesta de vacia, e ignora comentarios y lineas en blanco', () => {
    const claves = clavesDe(
      ['# un comentario', '', 'CON_VALOR=algo', 'VACIA=', '  ESPACIADA = otro ', '#COMENTADA=x'].join('\n'),
    );
    expect(claves.get('CON_VALOR')).toBe(true);
    expect(claves.get('VACIA')).toBe(false);
    expect(claves.get('ESPACIADA')).toBe(true);
    expect(claves.has('COMENTADA')).toBe(false);
  });

  it('tolera CRLF, que es lo que produce un editor de Windows', () => {
    const claves = clavesDe('UNA=1\r\nOTRA=\r\n');
    expect(claves.get('UNA')).toBe(true);
    expect(claves.get('OTRA')).toBe(false);
  });

  it('admite el prefijo `export`', () => {
    expect(clavesDe('export ANTHROPIC_API_KEY=x').get('ANTHROPIC_API_KEY')).toBe(true);
  });
});

describe('completar — no puede pisar lo que escribiste', () => {
  const variables = [
    { clave: 'YA_ESTABA', valor: 'nuevo-por-defecto' },
    { clave: 'FALTABA', valor: 'valor-por-defecto' },
  ];

  it('conserva byte a byte lo que habia, y solo añade al final', () => {
    const original = '# mis notas\nYA_ESTABA=lo-que-yo-puse\n';
    const { contenido, añadidas } = completar(original, variables);

    expect(contenido.startsWith(original)).toBe(true);
    expect(contenido).toContain('YA_ESTABA=lo-que-yo-puse');
    expect(contenido).not.toContain('YA_ESTABA=nuevo-por-defecto');
    expect(añadidas).toEqual(['FALTABA']);
  });

  it('respeta una variable presente pero VACIA: puede estar a medio poner', () => {
    const { contenido, añadidas } = completar('YA_ESTABA=\nFALTABA=x\n', variables);
    expect(añadidas).toEqual([]);
    expect(contenido).toBe('YA_ESTABA=\nFALTABA=x\n');
  });

  it('es idempotente: la segunda pasada no cambia nada', () => {
    const primera = completar('YA_ESTABA=mio\n', variables).contenido;
    const segunda = completar(primera, variables);
    expect(segunda.contenido).toBe(primera);
    expect(segunda.añadidas).toEqual([]);
  });

  it('añade el salto que falta si el archivo no terminaba en linea nueva', () => {
    const { contenido } = completar('YA_ESTABA=mio', variables);
    expect(contenido).toContain('YA_ESTABA=mio\n');
  });
});

describe('generarEsqueleto', () => {
  const esqueleto = generarEsqueleto();

  it('declara todas las variables que el esquema conoce', () => {
    for (const v of TODAS_LAS_VARIABLES) {
      expect(esqueleto, `falta ${v.clave}`).toContain(`${v.clave}=`);
    }
  });

  it('NO lleva ningun secreto: los deja en blanco', () => {
    // El esqueleto se genera en la maquina de cada uno, pero este test existe
    // porque el fallo original fue exactamente este: una plantilla con forma
    // de `.env` acabo con cinco credenciales reales dentro, y en un commit.
    for (const v of TODAS_LAS_VARIABLES.filter((x) => x.valor === '')) {
      expect(esqueleto).toContain(`${v.clave}=\n`);
    }
  });

  it('dice de donde sale cada dato imprescindible', () => {
    for (const v of TODAS_LAS_VARIABLES.filter((x) => x.imprescindible)) {
      expect(v.procedencia, `${v.clave} sin procedencia`).toBeTruthy();
      expect(esqueleto).toContain(v.procedencia!);
    }
  });

  it('trae los valores medidos, no los de la primera version', () => {
    // 0.75 apagaba la recuperacion entera sobre la base aprobada.
    expect(esqueleto).toContain('RAG_UMBRAL_SIMILITUD=0.5');
    expect(esqueleto).toContain('CLAUDE_MODEL_CLASIFICACION=claude-haiku-4-5-20251001');
  });

  it('deja los dos canales apagados: se encienden a proposito', () => {
    expect(esqueleto).toContain('VOICE_ENABLED=false');
    expect(esqueleto).toContain('WHATSAPP_ENABLED=false');
  });

  it('no declara dos veces la misma clave', () => {
    const claves = TODAS_LAS_VARIABLES.map((v) => v.clave);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it('cada grupo tiene titulo y al menos una variable', () => {
    for (const g of GRUPOS) {
      expect(g.titulo.length).toBeGreaterThan(0);
      expect(g.variables.length).toBeGreaterThan(0);
    }
  });
});
