/**
 * Tests para el instrumental de la Fase 7 (control C5 / riesgo A.1): medicion
 * de WER por segmento de hablante.
 *
 * Cubre, con casos verificables a mano:
 * - Distancia de edicion: sustitucion pura, insercion pura, eliminacion pura,
 *   cadena identica (WER 0), referencia vacia (ambas variantes) e hipotesis
 *   vacia (WER 100%).
 * - Normalizacion: minusculas, puntuacion, tildes, y numeros como palabras
 *   (incluyendo el caso motivador "4:30" frente a "cuatro y media").
 * - Agregacion por segmento y calculo de la brecha entre el mejor y el peor.
 */
import { describe, it, expect } from 'vitest';
import {
  calcularOperacionesEdicion,
  normalizarTexto,
  tokenizar,
  numeroAPalabras,
  convertirNumerosATexto,
  evaluarPar,
  agregarSegmento,
  calcularBrecha,
  evaluarConjunto,
  intervaloWilson,
  NORMALIZACION_POR_DEFECTO,
  UMBRALES_POR_DEFECTO,
  type ParEntrada,
} from '../../scripts/wer.js';

describe('calcularOperacionesEdicion', () => {
  it('cadena identica: cero operaciones', () => {
    const r = calcularOperacionesEdicion(['hola', 'mundo'], ['hola', 'mundo']);
    expect(r).toEqual({ sustituciones: 0, inserciones: 0, eliminaciones: 0, distancia: 0 });
  });

  it('sustitucion pura: una palabra distinta en la misma posicion', () => {
    // ref: "hola mundo" / hip: "hola tierra" -> 1 sustitucion
    const r = calcularOperacionesEdicion(['hola', 'mundo'], ['hola', 'tierra']);
    expect(r.sustituciones).toBe(1);
    expect(r.inserciones).toBe(0);
    expect(r.eliminaciones).toBe(0);
    expect(r.distancia).toBe(1);
  });

  it('insercion pura: la hipotesis tiene una palabra de mas', () => {
    // ref: "a b c" / hip: "a x b c" -> 1 insercion ("x")
    const r = calcularOperacionesEdicion(['a', 'b', 'c'], ['a', 'x', 'b', 'c']);
    expect(r.inserciones).toBe(1);
    expect(r.sustituciones).toBe(0);
    expect(r.eliminaciones).toBe(0);
    expect(r.distancia).toBe(1);
  });

  it('eliminacion pura: la hipotesis omite una palabra', () => {
    // ref: "a b c" / hip: "a c" -> 1 eliminacion ("b")
    const r = calcularOperacionesEdicion(['a', 'b', 'c'], ['a', 'c']);
    expect(r.eliminaciones).toBe(1);
    expect(r.sustituciones).toBe(0);
    expect(r.inserciones).toBe(0);
    expect(r.distancia).toBe(1);
  });

  it('ambas vacias: cero operaciones', () => {
    const r = calcularOperacionesEdicion([], []);
    expect(r).toEqual({ sustituciones: 0, inserciones: 0, eliminaciones: 0, distancia: 0 });
  });

  it('referencia vacia e hipotesis con palabras: todo son inserciones', () => {
    const r = calcularOperacionesEdicion([], ['a', 'b', 'c']);
    expect(r.inserciones).toBe(3);
    expect(r.distancia).toBe(3);
  });

  it('hipotesis vacia: todo son eliminaciones (distancia = palabras de referencia)', () => {
    const r = calcularOperacionesEdicion(['a', 'b', 'c'], []);
    expect(r.eliminaciones).toBe(3);
    expect(r.distancia).toBe(3);
  });

  it('caso mixto conocido: ref "el gato negro corre" / hip "el perro negro" ', () => {
    // sustitucion (gato->perro) + eliminacion (corre) = distancia 2
    const r = calcularOperacionesEdicion(
      ['el', 'gato', 'negro', 'corre'],
      ['el', 'perro', 'negro'],
    );
    expect(r.distancia).toBe(2);
    expect(r.sustituciones + r.inserciones + r.eliminaciones).toBe(2);
  });
});

describe('evaluarPar - WER por par (casos verificables a mano)', () => {
  it('cadena identica produce WER 0', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: 'hola mundo', hipotesis: 'hola mundo' };
    const r = evaluarPar(par);
    expect(r.wer).toBe(0);
    expect(r.palabrasReferencia).toBe(2);
  });

  it('sustitucion pura sobre 2 palabras de referencia: WER 0.5', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: 'hola mundo', hipotesis: 'hola tierra' };
    const r = evaluarPar(par);
    expect(r.wer).toBe(0.5);
    expect(r.sustituciones).toBe(1);
  });

  it('insercion pura sobre 3 palabras de referencia: WER 1/3', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: 'a b c', hipotesis: 'a x b c' };
    const r = evaluarPar(par);
    expect(r.wer).toBeCloseTo(1 / 3, 10);
  });

  it('eliminacion pura sobre 3 palabras de referencia: WER 1/3', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: 'a b c', hipotesis: 'a c' };
    const r = evaluarPar(par);
    expect(r.wer).toBeCloseTo(1 / 3, 10);
  });

  it('hipotesis vacia con referencia no vacia: WER = 100%', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: 'una dos tres', hipotesis: '' };
    const r = evaluarPar(par);
    expect(r.wer).toBe(1);
  });

  it('referencia vacia e hipotesis vacia: WER = 0 (nada que reconocer, nada mal reconocido)', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: '', hipotesis: '' };
    const r = evaluarPar(par);
    expect(r.wer).toBe(0);
    expect(r.palabrasReferencia).toBe(0);
  });

  it('referencia vacia con hipotesis no vacia: WER indefinido (null), no una cifra fabricada', () => {
    const par: ParEntrada = { hablante_id: 'h1', segmento: 'x', referencia: '', hipotesis: 'algo se dijo' };
    const r = evaluarPar(par);
    expect(r.wer).toBeNull();
  });
});

describe('normalizarTexto y tokenizar', () => {
  it('pasa a minusculas cuando esta activado', () => {
    expect(normalizarTexto('HOLA Mundo', { ...NORMALIZACION_POR_DEFECTO, quitarPuntuacion: false, quitarTildes: false, numerosComoPalabras: false })).toBe('hola mundo');
  });

  it('no toca mayusculas cuando minusculas esta desactivado', () => {
    const r = normalizarTexto('HOLA', { minusculas: false, quitarPuntuacion: false, quitarTildes: false, numerosComoPalabras: false });
    expect(r).toBe('HOLA');
  });

  it('quita puntuacion comun sin pegar palabras', () => {
    const r = normalizarTexto('Hola, ?como estas!', { minusculas: true, quitarPuntuacion: true, quitarTildes: false, numerosComoPalabras: false });
    expect(tokenizar(r)).toEqual(['hola', 'como', 'estas']);
  });

  it('quita tildes y normaliza la ene con virgulilla', () => {
    const conTildes = 'mañana revisaré la información del niño';
    const r = normalizarTexto(conTildes, { minusculas: false, quitarPuntuacion: false, quitarTildes: true, numerosComoPalabras: false });
    expect(r).toBe('manana revisare la informacion del nino');
  });

  it('tokenizar colapsa espacios multiples y descarta vacios', () => {
    expect(tokenizar('  hola    mundo  ')).toEqual(['hola', 'mundo']);
  });
});

describe('numeroAPalabras', () => {
  it('convierte digitos simples', () => {
    expect(numeroAPalabras(0)).toBe('cero');
    expect(numeroAPalabras(7)).toBe('siete');
  });

  it('convierte el rango 10-19', () => {
    expect(numeroAPalabras(10)).toBe('diez');
    expect(numeroAPalabras(15)).toBe('quince');
    expect(numeroAPalabras(19)).toBe('diecinueve');
  });

  it('convierte decenas y el rango 21-29 (forma "veinti-")', () => {
    expect(numeroAPalabras(20)).toBe('veinte');
    expect(numeroAPalabras(21)).toBe('veintiuno');
    expect(numeroAPalabras(26)).toBe('veintiseis');
    expect(numeroAPalabras(30)).toBe('treinta');
  });

  it('convierte decenas con "y" (31-99)', () => {
    expect(numeroAPalabras(31)).toBe('treinta y uno');
    expect(numeroAPalabras(45)).toBe('cuarenta y cinco');
    expect(numeroAPalabras(99)).toBe('noventa y nueve');
  });

  it('convierte centenas, con el caso especial de "cien"', () => {
    expect(numeroAPalabras(100)).toBe('cien');
    expect(numeroAPalabras(101)).toBe('ciento uno');
    expect(numeroAPalabras(230)).toBe('doscientos treinta');
    expect(numeroAPalabras(999)).toBe('novecientos noventa y nueve');
  });

  it('convierte miles, incluida la apocope de "uno" ante "mil"', () => {
    expect(numeroAPalabras(1000)).toBe('mil');
    expect(numeroAPalabras(2026)).toBe('dos mil veintiseis');
    expect(numeroAPalabras(21000)).toBe('veintiun mil');
  });

  it('fuera de rango soportado devuelve el numero tal cual, sin inventar', () => {
    expect(numeroAPalabras(1000000)).toBe('1000000');
  });
});

describe('convertirNumerosATexto - el caso motivador del encargo', () => {
  it('convierte "4:30" a "cuatro y media", igual que la referencia escrita en palabras', () => {
    expect(convertirNumerosATexto('a las 4:30 de la tarde')).toBe('a las cuatro y media de la tarde');
  });

  it('convierte horas en punto y cuarto', () => {
    expect(convertirNumerosATexto('cita a las 9:00')).toBe('cita a las nueve en punto');
    expect(convertirNumerosATexto('cita a las 9:15')).toBe('cita a las nueve y cuarto');
  });

  it('con la normalizacion completa, "4:30" e "cuatro y media" producen WER 0', () => {
    // Este es el ejemplo literal del encargo: "4:30" frente a "cuatro y media"
    // no es un error de reconocimiento del habla y no debe contar como tal.
    const par: ParEntrada = {
      hablante_id: 'h1',
      segmento: 'x',
      referencia: 'la cita es a las cuatro y media',
      hipotesis: 'la cita es a las 4:30',
    };
    const r = evaluarPar(par, NORMALIZACION_POR_DEFECTO);
    expect(r.wer).toBe(0);
  });

  it('sin la normalizacion de numeros, ese mismo par SI marca error (demuestra por que hace falta)', () => {
    const par: ParEntrada = {
      hablante_id: 'h1',
      segmento: 'x',
      referencia: 'la cita es a las cuatro y media',
      hipotesis: 'la cita es a las 4:30',
    };
    const sinNumeros = { ...NORMALIZACION_POR_DEFECTO, numerosComoPalabras: false };
    const r = evaluarPar(par, sinNumeros);
    expect(r.wer).toBeGreaterThan(0);
  });
});

describe('agregarSegmento', () => {
  it('cuenta hablantes UNICOS, no pares (un hablante puede tener varias frases)', () => {
    const pares = [
      evaluarPar({ hablante_id: 'h1', segmento: 'seg', referencia: 'a b', hipotesis: 'a b' }),
      evaluarPar({ hablante_id: 'h1', segmento: 'seg', referencia: 'c d', hipotesis: 'c d' }),
      evaluarPar({ hablante_id: 'h2', segmento: 'seg', referencia: 'e f', hipotesis: 'e f' }),
    ];
    const r = agregarSegmento('seg', pares);
    expect(r.numHablantes).toBe(2);
    expect(r.numPares).toBe(3);
  });

  it('el WER del segmento es a nivel de corpus (suma errores / suma palabras), no promedio simple', () => {
    // par corto con 100% de error + par largo perfecto: el promedio simple de
    // WER por frase daria 50%, pero a nivel de corpus el peso real es menor.
    const pares = [
      evaluarPar({ hablante_id: 'h1', segmento: 'seg', referencia: 'hola', hipotesis: 'chau' }), // 1 error / 1 palabra = 100%
      evaluarPar({ hablante_id: 'h2', segmento: 'seg', referencia: 'a b c d e f g h i j', hipotesis: 'a b c d e f g h i j' }), // 0 errores / 10 palabras
    ];
    const r = agregarSegmento('seg', pares);
    // total: 1 error / 11 palabras de referencia, NO (100% + 0%) / 2 = 50%
    expect(r.wer).toBeCloseTo(1 / 11, 10);
  });

  it('marca "insuficiente" por debajo del minimo absoluto de hablantes', () => {
    const pares = [evaluarPar({ hablante_id: 'h1', segmento: 'seg', referencia: 'a', hipotesis: 'a' })];
    const r = agregarSegmento('seg', pares, { minimoAbsoluto: 5, recomendado: 15 });
    expect(r.nivelConfianzaMuestra).toBe('insuficiente');
  });

  it('marca "minimo" cuando supera el absoluto pero no el recomendado', () => {
    const pares = Array.from({ length: 3 }, (_, i) =>
      evaluarPar({ hablante_id: `h${i}`, segmento: 'seg', referencia: 'a', hipotesis: 'a' }),
    );
    const r = agregarSegmento('seg', pares, { minimoAbsoluto: 2, recomendado: 10 });
    expect(r.nivelConfianzaMuestra).toBe('minimo');
  });

  it('marca "recomendado" cuando alcanza el umbral recomendado', () => {
    const pares = Array.from({ length: 10 }, (_, i) =>
      evaluarPar({ hablante_id: `h${i}`, segmento: 'seg', referencia: 'a', hipotesis: 'a' }),
    );
    const r = agregarSegmento('seg', pares, { minimoAbsoluto: 2, recomendado: 10 });
    expect(r.nivelConfianzaMuestra).toBe('recomendado');
  });
});

describe('calcularBrecha - la cifra que decide el despliegue', () => {
  function segmentoConWer(nombre: string, wer: number, numHablantes: number) {
    const pares = Array.from({ length: Math.max(numHablantes, 1) }, (_, i) =>
      evaluarPar({ hablante_id: `${nombre}-h${i}`, segmento: nombre, referencia: 'a', hipotesis: 'a' }),
    );
    const seg = agregarSegmento(nombre, pares, UMBRALES_POR_DEFECTO);
    // se fuerza el WER y el nivel de muestra para aislar la logica de la brecha
    return { ...seg, wer, numHablantes, nivelConfianzaMuestra: numHablantes >= UMBRALES_POR_DEFECTO.minimoAbsoluto ? seg.nivelConfianzaMuestra : ('insuficiente' as const) };
  }

  it('devuelve null con menos de dos segmentos con WER definido', () => {
    const soloUno = [segmentoConWer('a', 0.1, 20)];
    expect(calcularBrecha(soloUno)).toBeNull();
  });

  it('identifica correctamente mejor y peor segmento y calcula la brecha absoluta', () => {
    const segmentos = [
      segmentoConWer('limeno_estandar', 0.05, 20),
      segmentoConWer('andino_mayor', 0.35, 20),
      segmentoConWer('amazonico', 0.15, 20),
    ];
    const b = calcularBrecha(segmentos);
    expect(b).not.toBeNull();
    expect(b!.mejorSegmento).toBe('limeno_estandar');
    expect(b!.peorSegmento).toBe('andino_mayor');
    expect(b!.brechaAbsoluta).toBeCloseTo(0.3, 10);
    expect(b!.brechaRelativa).toBeCloseTo(7, 10);
  });

  it('marca muestraInsuficiente cuando el peor segmento no alcanza el minimo absoluto', () => {
    const segmentos = [
      segmentoConWer('limeno_estandar', 0.05, 20),
      segmentoConWer('quechua_l1', 0.4, 2), // solo 2 hablantes: por debajo del minimo por defecto (5)
    ];
    const b = calcularBrecha(segmentos);
    expect(b!.muestraInsuficiente).toBe(true);
  });

  it('no marca muestraInsuficiente cuando ambos extremos tienen muestra recomendada', () => {
    const segmentos = [
      segmentoConWer('limeno_estandar', 0.05, 20),
      segmentoConWer('andino_mayor', 0.12, 20),
    ];
    const b = calcularBrecha(segmentos);
    expect(b!.muestraInsuficiente).toBe(false);
  });

  it('brechaRelativa es Infinity si el mejor segmento tiene WER 0', () => {
    const segmentos = [segmentoConWer('a', 0, 20), segmentoConWer('b', 0.2, 20)];
    const b = calcularBrecha(segmentos);
    expect(b!.brechaRelativa).toBe(Infinity);
  });
});

describe('intervaloWilson', () => {
  it('devuelve null si no hay palabras de referencia', () => {
    expect(intervaloWilson(0, 0)).toBeNull();
  });

  it('devuelve null si la proporcion de errores supera 1 (mas inserciones que palabras)', () => {
    expect(intervaloWilson(15, 10)).toBeNull();
  });

  it('produce un intervalo que contiene la proporcion observada', () => {
    const intervalo = intervaloWilson(10, 100);
    expect(intervalo).not.toBeNull();
    expect(intervalo!.inferior).toBeLessThanOrEqual(0.1);
    expect(intervalo!.superior).toBeGreaterThanOrEqual(0.1);
  });

  it('el intervalo se angosta con mas muestra, para la misma proporcion', () => {
    const chico = intervaloWilson(1, 10)!;
    const grande = intervaloWilson(100, 1000)!;
    const anchoChico = chico.superior - chico.inferior;
    const anchoGrande = grande.superior - grande.inferior;
    expect(anchoGrande).toBeLessThan(anchoChico);
  });
});

describe('evaluarConjunto - orquestacion de punta a punta', () => {
  const entradas: ParEntrada[] = [
    { hablante_id: 'h1', segmento: 'limeno_estandar', referencia: 'hola buenas tardes', hipotesis: 'hola buenas tardes' },
    { hablante_id: 'h2', segmento: 'limeno_estandar', referencia: 'quiero una cita', hipotesis: 'quiero una cita' },
    { hablante_id: 'h3', segmento: 'andino_mayor', referencia: 'quiero una cita', hipotesis: 'quiero la cita' },
  ];

  it('agrupa por segmento y calcula un WER global coherente con la suma de errores', () => {
    const r = evaluarConjunto(entradas);
    expect(r.segmentos.map((s) => s.segmento)).toEqual(['andino_mayor', 'limeno_estandar']);
    expect(r.totalPares).toBe(3);
    // 1 sustitucion sobre 6 palabras de referencia en total (3+3+... referencia real: 3+3+3=9)
    const totalPalabras = entradas.reduce((acc, e) => acc + tokenizar(normalizarTexto(e.referencia)).length, 0);
    expect(r.totalPalabrasReferencia).toBe(totalPalabras);
    expect(r.wer).toBeCloseTo(1 / totalPalabras, 10);
  });

  it('agrega advertencia cuando un segmento no llega al minimo absoluto de hablantes', () => {
    const r = evaluarConjunto(entradas, { umbrales: { minimoAbsoluto: 5, recomendado: 15 } });
    expect(r.advertencias.some((a) => a.includes('andino_mayor'))).toBe(true);
    expect(r.advertencias.some((a) => a.includes('limeno_estandar'))).toBe(true);
  });

  it('sin al menos dos segmentos, la brecha es null y se advierte explicitamente', () => {
    const unSoloSegmento = entradas.filter((e) => e.segmento === 'limeno_estandar');
    const r = evaluarConjunto(unSoloSegmento);
    expect(r.brecha).toBeNull();
    expect(r.advertencias.some((a) => a.toLowerCase().includes('brecha'))).toBe(true);
  });
});
