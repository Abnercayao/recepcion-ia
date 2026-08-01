/**
 * La consola de inspeccion (`scripts/consola.ts`).
 *
 * Lo que se prueba aqui es lo que puede MENTIR: el espia que dice que hizo cada
 * capa, la traduccion del fallo del RAG y la puerta que protege una consola
 * escuchando en la red local. Una consola de inspeccion que se equivoca es peor
 * que no tenerla, porque se cree.
 *
 * No se levanta el servidor: eso exigiria `.env` completo y credenciales
 * reales. La comprobacion de extremo a extremo es `npm run consola`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EspiaDeGuardrails,
  EspiaDeRag,
  RegistroDelTurno,
  explicarFalloDeEmbeddings,
  tokenValido,
} from '../../scripts/consola.js';
import type { GuardrailResult, KnowledgeChunk, RagPort, TurnContext } from '../../src/core/types/index.js';

const RAIZ = join(import.meta.dirname, '..', '..');
const ctx = { history: [] } as unknown as TurnContext;

describe('consola — la puerta', () => {
  const token = 'e7cf6a1c-0000-4000-8000-1f2e3d4c5b6a';

  it('acepta el token exacto y nada mas', () => {
    expect(tokenValido(token, token)).toBe(true);
    expect(tokenValido(token, token.toUpperCase())).toBe(false);
    expect(tokenValido(token, token.slice(0, -1) + 'b')).toBe(false);
  });

  it('rechaza longitudes distintas sin lanzar', () => {
    // `timingSafeEqual` explota si los buffers no miden lo mismo; si esto
    // lanzara, un token corto tumbaria la consola en vez de recibir un 401.
    expect(() => tokenValido(token, '')).not.toThrow();
    expect(tokenValido(token, '')).toBe(false);
    expect(tokenValido(token, token + 'x')).toBe(false);
  });

  it('rechaza lo que no es una cadena', () => {
    for (const valor of [undefined, null, 42, {}, [token]]) {
      expect(tokenValido(token, valor)).toBe(false);
    }
  });
});

describe('consola — por que vino vacio el RAG', () => {
  /**
   * `RagService.retrieve` atrapa cualquier error y devuelve lista vacia (un
   * fail-safe deliberado), asi que desde fuera un 429 de Voyage y un «no hay
   * nada por encima del umbral» son identicos. Son diagnosticos OPUESTOS: uno
   * se arregla esperando, el otro tocando el umbral o la base.
   */
  it('reconoce el limite de tasa de Voyage y dice que hacer', () => {
    const explicacion = explicarFalloDeEmbeddings(
      'Voyage AI respondio 429 Too Many Requests: {"detail":"rate limit"}',
    );
    expect(explicacion).toContain('Voyage');
    expect(explicacion).toMatch(/esper/i);
    expect(explicacion).toContain('No es el prompt');
  });

  it('reconoce la clave ausente', () => {
    expect(explicarFalloDeEmbeddings('VOYAGE_API_KEY no esta configurada')).toContain('VOYAGE_API_KEY');
  });

  it('no se inventa un diagnostico para un fallo que no conoce', () => {
    expect(explicarFalloDeEmbeddings('ECONNRESET')).toContain('ECONNRESET');
  });

  it('distingue «vacio por fallo» de «vacio porque nada supero el umbral»', async () => {
    const registro = new RegistroDelTurno();
    const vacio: RagPort = { retrieve: () => Promise.resolve([]) };

    await new EspiaDeRag(vacio, registro).retrieve('c1', 'cuanto cuesta una limpieza');
    expect(registro.consultasRag[0]?.motivoVacio).toContain('umbral');

    registro.reiniciar();
    registro.falloDeEmbeddings = explicarFalloDeEmbeddings('Voyage AI respondio 429');
    await new EspiaDeRag(vacio, registro).retrieve('c1', 'cuanto cuesta una limpieza');
    expect(registro.consultasRag[0]?.motivoVacio).toContain('Voyage');
  });

  it('no marca motivo cuando si hubo fragmentos', async () => {
    const registro = new RegistroDelTurno();
    const chunk: KnowledgeChunk = {
      id: 'f1',
      clinicId: 'c1',
      contenido: 'Profilaxis y limpieza dental: S/ 90 a S/ 150',
      fuente: 'formulario',
      similarity: 0.73,
    };
    await new EspiaDeRag({ retrieve: () => Promise.resolve([chunk]) }, registro).retrieve('c1', 'limpieza');

    expect(registro.consultasRag[0]?.motivoVacio).toBeUndefined();
    expect(registro.consultasRag[0]?.fragmentos[0]?.similitud).toBe(0.73);
  });
});

describe('consola — el espia de capa 2', () => {
  const pasa: GuardrailResult = { pass: true };
  const bloquea: GuardrailResult = {
    pass: false,
    reason: 'precio_cerrado_sin_valoracion',
    replacement: 'Le puedo dar un rango de referencia…',
  };

  const espiar = (resultado: GuardrailResult, registro: RegistroDelTurno): EspiaDeGuardrails =>
    new EspiaDeGuardrails(
      { checkInbound: () => pasa, checkOutbound: () => resultado },
      registro,
    );

  it('no registra nada cuando la capa no interviene', () => {
    const registro = new RegistroDelTurno();
    espiar(pasa, registro).checkOutbound('todo correcto', ctx);
    expect(registro.capa2).toEqual([]);
  });

  it('deduplica: el orquestador verifica prefijos crecientes del mismo texto', () => {
    const registro = new RegistroDelTurno();
    const espia = espiar(bloquea, registro);
    espia.checkOutbound('Son', ctx);
    espia.checkOutbound('Son S/ 3,000', ctx);
    espia.checkOutbound('Son S/ 3,000 fijos', ctx);

    // Una sola violacion, no tres: el panel no puede exagerar cuantas veces
    // intervino de verdad la capa.
    expect(registro.capa2).toHaveLength(1);
  });

  it('se queda con el texto MAS COMPLETO que el modelo llego a producir', () => {
    const registro = new RegistroDelTurno();
    const espia = espiar(bloquea, registro);
    espia.checkOutbound('Son', ctx);
    espia.checkOutbound('Son S/ 3,000 fijos, sin valoracion', ctx);
    espia.checkOutbound('Son S/ 3,000', ctx);

    // Es EL dato del panel: lo que el modelo dijo de verdad y el paciente no
    // vio. Con el primer prefijo que dispara no se puede juzgar si el control
    // salvo la situacion o se disparo de mas.
    expect(registro.capa2[0]?.textoDelModelo).toBe('Son S/ 3,000 fijos, sin valoracion');
  });

  it('deja pasar el resultado sin tocarlo: observa, no decide', () => {
    const registro = new RegistroDelTurno();
    expect(espiar(bloquea, registro).checkOutbound('lo que sea', ctx)).toEqual(bloquea);
  });

  it('`reiniciar` deja el registro limpio entre turnos', () => {
    const registro = new RegistroDelTurno();
    espiar(bloquea, registro).checkOutbound('Son S/ 3,000', ctx);
    registro.falloDeEmbeddings = 'algo';
    registro.reiniciar();

    expect(registro.capa2).toEqual([]);
    expect(registro.consultasRag).toEqual([]);
    expect(registro.falloDeEmbeddings).toBeUndefined();
  });
});

describe('consola — no es un canal y no llega a produccion', () => {
  /**
   * `Channel` son dos valores por doctrina y el servidor de produccion sera
   * publicamente alcanzable en cuanto entre WhatsApp o voz. Un endpoint de
   * chat sin autenticar que gasta dinero y escribe en la base no puede
   * compartir esa superficie: la consola vive en `scripts/` y se queda ahi.
   */
  it('`src/` no importa nada de la consola', async () => {
    const server = await readFile(join(RAIZ, 'src', 'server.ts'), 'utf8');
    expect(server).not.toContain('consola');
  });

  it('la consola no añade un tercer canal', async () => {
    const canal = await readFile(join(RAIZ, 'src', 'core', 'types', 'channel.ts'), 'utf8');
    expect(canal).toContain("export type Channel = 'whatsapp' | 'voice';");
  });

  it('la pagina es autocontenida: no carga nada de fuera', async () => {
    const html = await readFile(join(RAIZ, 'scripts', 'consola.html'), 'utf8');
    // Sin CDN, sin fuentes remotas, sin imagenes externas: la consola tiene que
    // funcionar en una maquina sin salida a internet salvo la del propio agente.
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import\s+url\(/i);
  });
});
